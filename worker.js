const SYSTEM_PROMPT = `Ты — методист и навигатор проективных практик в Telegram-боте, работающий в парадигме психосинергетики и системы метафорических ассоциативных карт (колода «МАК37»).

Твоя задача: принять описание проблемной ситуации клиента, при необходимости задать 1–2 точных уточняющих вопроса, чтобы отделить факты от эмоций, и перевести запрос в чёткую исследовательскую задачу для самостоятельного расклада: один вопрос-вовне и несколько вопросов-вовнутрь.

Принципы работы:
1. Никакой эзотерики, мистицизма и фатализма. Карты — не оракул и не способ «угадать судьбу». Это проективный резонатор, который сбивает привычный логический автопилот и помогает увидеть слепые зоны.
2. Тон и стиль: спокойный, ясный, поддерживающий, но трезвый и аналитический. Без пафоса, терапевтического жаргона, канцеляризмов и токсичной вины.
3. Формат мессенджера: пиши короткими абзацами и списками.
4. Граница роли: никогда не тяни карты за клиента, не предсказывай исход и не давай директивных советов.

Алгоритм диалога:
Шаг 1. Если ситуация описана слишком общо — задай 1–2 коротких уточняющих вопроса (между какими вариантами идёт выбор и что зависит от самого человека). Не выдавай вопросы для карт сразу.
Шаг 2. Когда контекст ясен, отвечай строго по структуре:
1. Точка выбора (где застряло мышление) — 2–3 предложения о конфликте факторов + 1 предложение о когнитивной ловушке.
2. Вопрос-вовне (разведка декораций) — ровно один вопрос на трезвую оценку среды + краткое пояснение в скобках, зачем нужен этот фильтр.
3. Вопросы-вовнутрь (рабочие запросы для карт) — 3–4 коротких вопроса (до 12–15 слов каждый): На слепую зону, На ресурс, На действие, На смену рамки (опционально).
В конце одной строкой предложи выбрать один вопрос-вовнутрь, вытянуть карту из «МАК37» и при желании написать сюда, что выпало.
Шаг 3. Если клиент прислал выпавшую карту и ассоциации — сначала структурируй его собственные образы без директивных трактовок, затем помоги перевести инсайт в одно простое действие на ближайшие 24 часа.`;

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");

    try {
      const update = await request.json();

      // Обработка нажатия на кнопку "Я подписался"
      if (update.callback_query) {
        const cb = update.callback_query;
        const userId = cb.from.id;
        const chatId = cb.message.chat.id;

        if (cb.data === "check_sub") {
          const isMember = await checkSubscription(env.BOT_TOKEN, env.CHANNEL_ID, userId);
          await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ callback_query_id: cb.id })
          });

          if (isMember) {
            await sendTelegram(env.BOT_TOKEN, chatId, "Доступ открыт. Опишите ситуацию или дилемму, с которой вы хотите поработать через «МАК37».\n\n(Чтобы начать новый разбор с чистого листа в любой момент, отправьте команду /reset)");
          } else {
            await sendTelegram(env.BOT_TOKEN, chatId, "Подписка пока не найдена. Пожалуйста, подпишитесь на канал и нажмите кнопку проверки ещё раз.");
          }
        }
        return new Response("OK");
      }

      if (!update.message || !update.message.text) return new Response("OK");

      const chatId = update.message.chat.id;
      const userId = update.message.from.id;
      const userText = update.message.text.trim();

      // 1. Проверка подписки на канал перед любым действием
      const isSubscribed = await checkSubscription(env.BOT_TOKEN, env.CHANNEL_ID, userId);
      if (!isSubscribed) {
        await sendSubscriptionPrompt(env.BOT_TOKEN, chatId, env.CHANNEL_LINK);
        return new Response("OK");
      }

      // 2. Команды управления диалогом
      if (userText === "/start") {
        await env.CHAT_HISTORY.delete(String(chatId));
        await sendTelegram(
          env.BOT_TOKEN,
          chatId,
          "Добро пожаловать в навигатор «МАК37».\n\nЗдесь нет гаданий и предсказаний — мы переводим запутанные ситуации в точные исследовательские вопросы для работы с колодой.\n\nОпишите ситуацию или дилемму, в которой вы сейчас находитесь."
        );
        return new Response("OK");
      }

      if (userText === "/reset") {
        await env.CHAT_HISTORY.delete(String(chatId));
        await sendTelegram(env.BOT_TOKEN, chatId, "Контекст очищен. Опишите новую ситуацию для разбора.");
        return new Response("OK");
      }

      // 3. Загрузка истории диалога из Cloudflare KV
      let history = [];
      const saved = await env.CHAT_HISTORY.get(String(chatId));
      if (saved) history = JSON.parse(saved);

      history.push({ role: "user", parts: [{ text: userText }] });
      if (history.length > 10) history = history.slice(-10);

      // 4. Запрос к Gemini API
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: history,
            generationConfig: { temperature: 0.4 }
          })
        }
      );

      const geminiData = await geminiRes.json();
      const reply = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "Не удалось обработать запрос. Попробуйте переформулировать.";

      // Сохраняем ответ в историю
      history.push({ role: "model", parts: [{ text: reply }] });
      await env.CHAT_HISTORY.put(String(chatId), JSON.stringify(history), { expirationTtl: 86400 });

      await sendTelegram(env.BOT_TOKEN, chatId, reply);
    } catch (e) {
      console.error(e);
    }

    return new Response("OK");
  }
};

async function checkSubscription(botToken, channelId, userId) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${channelId}&user_id=${userId}`);
  const data = await res.json();
  if (!data.ok) return false;
  const status = data.result.status;
  return ["creator", "administrator", "member"].includes(status);
}

async function sendSubscriptionPrompt(botToken, chatId, channelLink) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: "Этот навигатор доступен только подписчикам канала. Подпишитесь, чтобы начать работу с «МАК37»:",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Перейти в канал", url: channelLink }],
          [{ text: "Я подписался — проверить", callback_data: "check_sub" }]
        ]
      }
    })
  });
}

async function sendTelegram(botToken, chatId, text) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown"
    })
  });
}
