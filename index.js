require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const cors = require('cors');
const crypto = require('crypto');
const app = express();
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} request to ${req.url}`);
    if (req.method === 'POST') {
        console.log('Body:', JSON.stringify(req.body, null, 2));
    }
    next();
});
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Професійний промпт для продажів
const SYSTEM_PROMPT_TEMPLATE = `
### РОЛЬ
Ти — професійний продавець-консультант. Твоя мета: бути максимально корисним, експертно відповідати на питання щодо товарів та успішно закривати продажі.

### КОНТЕКСТ (ТОВАРИ)
Ось список релевантних товарів з нашої бази:
{context}

### ПРАВИЛО МОВИ (ПРИОРІТЕТ)
1. Автоматично визначай мову, якою до тебе звернувся клієнт.
2. Відповідай ВИКЛЮЧНО тією ж мовою, якою розмовляє клієнт (English, Polski, Deutsch, Українська тощо).
3. Весь інтерфейс відповіді та назви характеристик мають бути адаптовані під мову клієнта.

### ІНСТРУКЦІЇ З ОБРОБКИ ТОВАРІВ
1. АНАЛІЗ НАЯВНОСТІ: 
   - Якщо товари знайдені, опиши їхні переваги, базуючись ТІЛЬКИ на наданому описі.
   - Якщо клієнт питає про товар, якого немає в списку — ввічливо повідом про відсутність і запропонуй найкращу альтернативу з наявних.
   - Якщо контекст порожній ({context} не містить товарів), запитай клієнта, що саме його цікавить, щоб уточнити пошук.

2. ВАРІАТИВНІ ТОВАРИ (Атрибути):
   - Якщо поле 'variations' порожнє або null — не згадуй про варіанти. Виводь лише назву та ціну.
   - Якщо товар має варіації (колір, розмір тощо) — ВИВОДЬ ЇХ СПИСКОМ.
   - ОБОВ'ЯЗКОВО акцентуй увагу на доступних характеристиках (наприклад: "Ця модель доступна у кольорах: Синій, Чорний").
   - УТОЧНЕННЯ: Якщо клієнт обрав варіативний товар, але не вказав конкретний атрибут, ти МАЄШ запитати його про параметри, перелічивши всі варіанти з блоку "Доступні параметри" для цього ID.

3. ДОДАВАННЯ В КОШИК:
   - Якщо товар варіативний — НЕ додавай його в кошик одразу. Спершу отримай від клієнта вибір конкретних параметрів.

### СТИЛЬ ТА СТРУКТУРА ВІДПОВІДІ
- Тон: Професійний, привітний, допоміжний.
- Лаконічність: Будь стислим, не вигадуй неіснуючі характеристики.
- Заклик до дії: Наприкінці кожної відповіді обов'язково нагадуй, що ти можеш допомогти з оформленням замовлення.
- Асортимент: Якщо клієнт просить "показати щось" або "які є товари", виведи наявні в {context} товари як асортимент.
`;

app.get('/', (req, res) => res.send('AI Sales Agent Server is Live!'));

// 1. Ендпоінт для синхронізації
app.post('/api/v1/sync-product', async (req, res) => {
    try {
        // 1. Отримуємо ВСІ поля з тіла запиту
        console.log("FULL BODY RECEIVED:", JSON.stringify(req.body, null, 2));
        const { store_id, product_id, title, description, price, sale_price, image, permalink, is_variable, attributes } = req.body;

        console.log(`Отримано дані для: ${title}`);
        console.log(`Image URL: ${image}`); // Тепер ти побачиш це в терміналі

        const embeddingResponse = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: `${title}. ${description}`,
        });

        const embedding = embeddingResponse.data[0].embedding;

        // 2. Записуємо їх у метадані
        const { error } = await supabase.from('products').upsert({
            store_id,
            wp_id: product_id,
            content: `${title} - ${description}`,
            metadata: {
                title,
                price,
                sale_price: sale_price || null,
                image: image || null,
                permalink,
                is_variable: is_variable || false,
                attributes: attributes || {}
            },
            embedding: embedding
        }, { onConflict: 'store_id,wp_id' });

        if (error) throw error;
        res.json({ success: true, message: `Product ${product_id} synced with image and sale price.` });
    } catch (err) {
        console.error('Sync Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 2. Ендпоінт для чату
app.post('/api/v1/chat', async (req, res) => {
    try {
        const { message, store_id } = req.body;
        const clean_store_id = store_id ? store_id.trim() : '';

        console.log(`--- Запит: ${message} (Store: ${clean_store_id}) ---`);

        // 1. Пошук товарів для контексту (залишаємо як базовий контекст)
        const queryEmbeddingResponse = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: message,
        });
        const queryEmbedding = queryEmbeddingResponse.data[0].embedding;

        // Викликаємо твій RPC match_products
        let { data: products, error: rpcError } = await supabase.rpc('match_products', {
            query_embedding: queryEmbedding,
            match_threshold: 0.25, // Трохи піднімаємо поріг для якості
            match_count: 5,
            filter_store_id: clean_store_id
        });

        // Якщо нічого не знайдено вектором — беремо останні додані як запасний варіант
        if (!products || products.length === 0) {
            const { data: fallback } = await supabase.from('products')
                .select('*')
                .eq('store_id', clean_store_id)
                .order('id', { ascending: false })
                .limit(3);
            products = fallback || [];
        }

        // РОЗШИРЕНИЙ КОНТЕКСТ: Даємо ШІ опис та атрибути для аналізу
        const context = products.length > 0
            ? products.map(p => {
                // Формуємо рядок з атрибутами та їх значеннями
                let attrsInfo = 'немає';
                if (p.metadata.attributes && Object.keys(p.metadata.attributes).length > 0) {
                    attrsInfo = Object.entries(p.metadata.attributes)
                        .map(([name, values]) => {
                            // Чистимо назву (pa_size -> Size)
                            const label = name.replace('pa_', '').toUpperCase();
                            // Якщо values - це масив або об'єкт, з'єднуємо через кому
                            const options = Array.isArray(values) ? values : Object.values(values);
                            return `${label}: ${options.join(', ')}`;
                        })
                        .join('; ');
                }

                return `ID: ${p.wp_id}
                Товар: ${p.metadata.title}
                Ціна: ${p.metadata.price} грн ${p.metadata.sale_price ? `(Акція: ${p.metadata.sale_price} грн)` : ''}
                Опис: ${p.content}
                Доступні варіанти: ${attrsInfo}`;
            }).join('\n\n---\n\n')
            : "Товари не знайдено.";

        // 2. Описуємо інструменти (Tools) для ШІ
        const tools = [{
            type: "function",
            function: {
                name: "get_order_status",
                description: "Отримує статус замовлення WooCommerce за його номером ID",
                parameters: {
                    type: "object",
                    properties: {
                        order_id: { type: "string", description: "ID замовлення, наприклад 123" }
                    },
                    required: ["order_id"]
                }
            }
        }];

        // 3. Перший запит до OpenAI (з перевіркою на виклик функцій)
        let messages = [
            { role: "system", content: SYSTEM_PROMPT_TEMPLATE.replace('{context}', context) },
            { role: "user", content: message }
        ];

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: messages,
            tools: tools,
            tool_choice: "auto",
        });

        const responseMessage = completion.choices[0].message;

        // 4. Якщо ШІ хоче викликати функцію перевірки замовлення
        if (responseMessage.tool_calls) {
            const toolCall = responseMessage.tool_calls[0];
            const args = JSON.parse(toolCall.function.arguments);

            console.log(`ШІ запитує статус замовлення #${args.order_id}`);

            try {
                // Виклик твого WordPress API (переконайся, що URL правильний)
                const wpUrl = `http://${clean_store_id}/wp-json/ai-sales/v1/order-status`;
                const wpRes = await fetch(wpUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ order_id: args.order_id })
                });

                const orderStatusData = await wpRes.json();

                // Додаємо відповідь інструменту в історію діалогу
                messages.push(responseMessage);
                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(orderStatusData)
                });

                // Отримуємо фінальну відповідь від ШІ на основі даних про замовлення
                const secondCompletion = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: messages
                });

                return res.json({
                    reply: secondCompletion.choices[0].message.content,
                    products: products.slice(0, 2).map(p => ({ // Показуємо 2 товари як рекомендацію
                        id: p.wp_id,
                        title: p.metadata.title,
                        price: p.metadata.price,
                        sale_price: p.metadata.sale_price,
                        image: p.metadata.image,
                        link: p.metadata.permalink,
                        attributes: p.metadata.attributes || {},
                        is_variable: p.metadata.is_variable || false
                    }))
                });

            } catch (err) {
                console.error("Помилка WP API:", err.message);
                return res.json({ reply: "Вибачте, не вдалося зв'язатися з базою замовлень.", products: [] });
            }
        }

        // 5. Якщо звичайна розмова (без функцій)
        res.json({
            reply: responseMessage.content,
            products: products.map(p => ({
                id: p.wp_id,
                title: p.metadata.title,
                price: p.metadata.price,
                sale_price: p.metadata.sale_price,
                image: p.metadata.image,
                link: p.metadata.permalink,
                attributes: p.metadata.attributes || {},
                is_variable: p.metadata.is_variable || false
            }))
        });

    } catch (err) {
        console.error('Chat Error:', err.message);
        res.status(500).json({ error: "Помилка сервера" });
    }
});

// 3. Ендпоінт для перевірки ліцензії
app.post('/api/v1/verify-license', async (req, res) => {
    try {
        const { license_key, store_id } = req.body;
        console.log("Отримано ключ для перевірки:", license_key);
        // Чистка даних
        const clean_key = license_key ? license_key.trim() : '';
        const clean_store_id = store_id ? store_id.replace(/^https?:\/\//, '').replace(/\/$/, '').trim() : '';

        if (!clean_key) {
            return res.json({ status: 'invalid', message: 'Ключ порожній' });
        }

        // Шукаємо ліцензію (використовуємо .ilike для ігнорування регістру, якщо потрібно)
        const { data: license, error } = await supabase
            .from('licenses')
            .select('*')
            .eq('license_key', clean_key)
            .single();

        if (error || !license) {
            console.log(`Ключ не знайдено: ${clean_key}`);
            return res.json({ status: 'invalid', message: 'Ліцензію не знайдено в базі' });
        }

        // --- ЛОГІКА ПЕРЕВІРКИ ТЕРМІНУ ---
        const now = new Date();
        const expiresAt = new Date(license.expires_at);

        // Розрахунок різниці в днях
        const diffInMs = expiresAt - now;
        const daysLeft = Math.ceil(diffInMs / (1000 * 60 * 60 * 24));

        // 1. Якщо термін вийшов або статус не active
        if (daysLeft <= 0 || license.status !== 'active') {
            return res.json({
                status: 'expired',
                message: 'Термін дії ліцензії закінчився'
            });
        }

        // 2. Прив'язка або перевірка домену
        if (license.store_id && license.store_id !== clean_store_id) {
            return res.json({
                status: 'invalid',
                message: 'Ця ліцензія вже прив’язана до іншого домену'
            });
        }

        // Якщо домен ще не прив'язаний — прив'язуємо
        if (!license.store_id) {
            await supabase.from('licenses')
                .update({ store_id: clean_store_id })
                .eq('id', license.id);
        }

        // 3. ПЕРЕВІРКА НА ПОПЕРЕДЖЕННЯ (3 дні або менше)
        if (daysLeft <= 3) {
            return res.json({
                status: 'warning',
                days_left: daysLeft,
                message: `Ліцензія закінчується через ${daysLeft} дн.`,
                expires_at: license.expires_at
            });
        }

        // 4. Якщо все ідеально
        return res.json({
            status: 'valid',
            message: 'Ліцензія активна',
            expires_at: license.expires_at
        });

    } catch (err) {
        console.error('Помилка валідації:', err);
        res.status(500).json({ error: "Помилка сервера при перевірці" });
    }
});

// Ендпоінт для створення нової ліцензії (Адмінський)
app.post('/api/v1/generate-license', async (req, res) => {
    try {
        const { admin_secret, months_valid } = req.body;

        const MY_SECRET = process.env.SUPER_SECRET_ADMIN_PASSWORD;
        if (admin_secret !== MY_SECRET) {
            return res.status(403).json({ error: "Доступ заборонено" });
        }

        // 1. ГЕНЕРАЦІЯ КЛЮЧА З ВЕЛИКИМИ ТА МАЛИМИ ЛІТЕРАМИ
        const generateKey = (length) => {
            const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
            let result = "";
            const randomBytes = crypto.randomBytes(length);
            for (let i = 0; i < length; i++) {
                // Вибираємо символ з набору charset на основі випадкового байта
                result += charset[randomBytes[i] % charset.length];
            }
            return result;
        };

        // Створюємо ключ формату ASA- (наприклад, 40 символів змішаного регістру)
        const license_key = `ASA-${generateKey(40)}`;

        // 2. ДАТА ЗАКІНЧЕННЯ
        const expires_at = new Date();
        expires_at.setMonth(expires_at.getMonth() + (parseInt(months_valid) || 12));

        // 3. АВТОМАТИЧНИЙ ЗАПИС У SUPABASE
        const { data, error } = await supabase
            .from('licenses')
            .insert([
                {
                    license_key: license_key,
                    status: 'active',
                    expires_at: expires_at.toISOString()
                }
            ])
            .select();

        if (error) {
            console.error('Supabase Error:', error.message);
            return res.status(500).json({ error: "Не вдалося зберегти ключ у базу" });
        }

        res.json({
            success: true,
            license_key: license_key,
            expires_at: expires_at,
            message: "Ліцензія створена та внесена в базу"
        });

    } catch (err) {
        console.error('Server Error:', err);
        res.status(500).json({ error: "Помилка сервера" });
    }
});

// Ендпоінт для деактивації ліцензії (відв'язка домену)
app.post('/api/v1/deactivate-license', async (req, res) => {
    try {
        const { license_key, store_id } = req.body;
        const clean_store_id = store_id ? store_id.replace(/^https?:\/\//, '').replace(/\/$/, '').trim() : '';

        // Перевіряємо, чи існує така ліцензія і чи вона прив'язана саме до цього домену
        const { data: license, error } = await supabase
            .from('licenses')
            .select('*')
            .eq('license_key', license_key)
            .eq('store_id', clean_store_id)
            .single();

        if (error || !license) {
            return res.json({ status: 'error', message: 'Ліцензія не знайдена або не прив\'язана до цього сайту' });
        }

        // Обнуляємо store_id
        await supabase.from('licenses')
            .update({ store_id: null })
            .eq('id', license.id);

        res.json({ status: 'success', message: 'Ліцензію успішно відв’язано від домену' });

    } catch (err) {
        res.status(500).json({ error: "Помилка сервера при деактивації" });
    }
});

// Сторінка адмін-панелі
app.get('/admin/licenses', async (req, res) => {
    const { secret } = req.query;
    const MY_SECRET = process.env.SUPER_SECRET_ADMIN_PASSWORD;

    if (secret !== MY_SECRET) {
        return res.status(403).send("<h1>Доступ заборонено</h1><p>Будь ласка, вкажіть правильний secret у URL.</p>");
    }

    try {
        const { data: licenses, error } = await supabase
            .from('licenses')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        // Генеруємо HTML таблиці
        const rows = licenses.map(lic => `
            <tr>
                <td><code>${lic.license_key}</code></td>
                <td><span class="status ${lic.status}">${lic.status}</span></td>
                <td>
                    ${lic.store_id ? `<b>${lic.store_id}</b> <button class="btn-reset" onclick="resetStore('${lic.id}')">🔄 Скинути</button>` : '<span class="empty">Вільна</span>'}
                </td>
                <td>${new Date(lic.expires_at).toLocaleDateString()}</td>
                <td>
                    <button onclick="copyKey('${lic.license_key}')">Копіювати</button>
                </td>
            </tr>
        `).join('');

        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>ASA License Admin</title>
            <style>
                body { font-family: sans-serif; background: #f4f7f6; padding: 40px; color: #333; }
                .container { max-width: 1000px; margin: 0 auto; background: #fff; padding: 20px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
                h1 { border-bottom: 2px solid #eee; padding-bottom: 10px; }
                table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                th, td { text-align: left; padding: 12px; border-bottom: 1px solid #eee; }
                th { background: #f8f9fa; }
                code { background: #f0f0f0; padding: 4px 8px; border-radius: 4px; font-size: 0.9em; }
                .status { padding: 4px 8px; border-radius: 12px; font-size: 0.8em; font-weight: bold; text-transform: uppercase; }
                .active { background: #e6fffa; color: #2c7a7b; }
                .expired { background: #fff5f5; color: #c53030; }
                .empty { color: #ccc; font-style: italic; }
                button { cursor: pointer; background: #2563eb; color: #fff; border: none; padding: 5px 10px; border-radius: 4px; }
                button:hover { background: #1d4ed8; }
                .btn-reset {
                    background: #fef2f2;
                    color: #991b1b;
                    border: 1px solid #fecaca;
                    font-size: 11px;
                    margin-left: 10px;
                    padding: 2px 6px;
                }
                .btn-reset:hover {
                    background: #fee2e2;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🔑 ASA License Manager</h1>
                <table>
                    <thead>
                        <tr>
                            <th>Ключ</th>
                            <th>Статус</th>
                            <th>Домен (Store ID)</th>
                            <th>Дійсний до</th>
                            <th>Дії</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <script>
                function copyKey(text) {
                    navigator.clipboard.writeText(text);
                    alert('Ключ скопійовано!');
                }
            </script>
        </body>
        </html>
        `;

        res.send(html);

    } catch (err) {
        res.status(500).send("Помилка бази даних");
    }
});

// Ендпоїнт для скидання прив'язки домену (Reset Store ID)
app.post('/api/v1/admin/reset-store', async (req, res) => {
    try {
        const { admin_secret, license_id } = req.body;
        const MY_SECRET = "SUPER_SECRET_ADMIN_PASSWORD_123";

        if (admin_secret !== MY_SECRET) {
            return res.status(403).json({ error: "Доступ заборонено" });
        }

        const { error } = await supabase
            .from('licenses')
            .update({ store_id: null }) // Очищаємо домен
            .eq('id', license_id);

        if (error) throw error;

        res.json({ success: true, message: "Прив'язку домену скинуто" });
    } catch (err) {
        res.status(500).json({ error: "Помилка сервера" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server ready on http://localhost:${PORT}`));