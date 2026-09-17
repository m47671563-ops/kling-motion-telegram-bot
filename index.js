// clean deploy    async function tg(env, method, body) {
  const url =
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = await r.text();

  console.log("TELEGRAM RESPONSE", {
    method: method,
    status: r.status,
    response: raw,
  });

  if (!r.ok) {
    throw new Error(
      `Telegram HTTP ${r.status}: ${raw}`
    );
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Telegram returned invalid JSON: ${raw}`
    );
  }

  if (!data.ok) {
    throw new Error(
      `Telegram API error: ${raw}`
    );
  }

  return data.result;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}



async function getTelegramFileUrl(env, fileId) {
  const file = await tg(env, "getFile", { file_id: fileId });
  return `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
}

function getPhotoId(message) {
  const photos = message?.photo;
  return photos?.length ? photos[photos.length - 1].file_id : null;
}

function getVideoId(message) {
  if (message?.video?.file_id) return message.video.file_id;
  if (message?.document?.mime_type?.startsWith("video/")) return message.document.file_id;
  return null;
}

function extractImageIdFromReply(message) {
  const t = message?.reply_to_message?.text || "";
  const m = t.match(/^IMG:([A-Za-z0-9_-]+)$/m);
  return m ? m[1] : null;
}

async function submitFal(env, imageUrl, videoUrl, orientation, callbackUrl) {
  const r = await fetch(`https://queue.fal.run/${MODEL}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${env.FAL_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: {
        image_url: imageUrl,
        video_url: videoUrl,
        character_orientation: orientation,
        keep_original_sound: true,
      },
      webhookUrl: callbackUrl,
    }),
  });

  const data = await r.json();
  if (!r.ok) throw new Error(`fal submit failed: ${JSON.stringify(data)}`);
  return data;
}

async function handleTelegramUpdate(update, env) {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;

  if (message.text === "/start" || message.text === "/help") {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "🔥 Kling Motion Bot siap!\n\n" +
        "1. Kirim FOTO karakter/pakaian.\n" +
        "2. Bot akan minta VIDEO referensi gerakan.\n" +
        "3. Balas (Reply) pesan bot tersebut dengan VIDEO.\n" +
        "4. Pilih orientasi Image atau Video.",
    });
    return;
  }

  const photoId = getPhotoId(message);
  if (photoId) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "📸 Foto diterima!\n\n" +
        "Sekarang kirim VIDEO referensi gerakan dengan cara Reply pesan ini.\n\n" +
        `IMG:${photoId}`,
    });
    return;
  }

  const videoId = getVideoId(message);
  if (videoId) {
    const imageId = extractImageIdFromReply(message);
    if (!imageId) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ Reply pesan bot dengan video supaya fotonya bisa dipasangkan.",
      });
      return;
    }

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "🎬 Video diterima!\n\nPilih orientasi:",
      reply_markup: {
        inline_keyboard: [[
          { text: "🖼️ Image", callback_data: `gen|image|${imageId}|${videoId}` },
          { text: "🎥 Video", callback_data: `gen|video|${imageId}|${videoId}` }
        ]],
      },
    });
  }
}

async function handleCallback(update, env, requestUrl) {
  const q = update.callback_query;
  if (!q?.data) return;

  await tg(env, "answerCallbackQuery", { callback_query_id: q.id });

  const parts = q.data.split("|");
  if (parts.length !== 4 || parts[0] !== "gen") return;

  const [, orientation, imageId, videoId] = parts;
  const chatId = q.message.chat.id;

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "⏳ Oke ngab, Kling lagi proses. Tunggu sampai videonya jadi ya 🔥",
  });

  try {
    const imageUrl = await getTelegramFileUrl(env, imageId);
    const videoUrl = await getTelegramFileUrl(env, videoId);

    const callbackUrl =
      `${new URL(requestUrl).origin}/fal-webhook?chat_id=${encodeURIComponent(chatId)}`;

    const result = await submitFal(
      env,
      imageUrl,
      videoUrl,
      orientation,
      callbackUrl
    );

    console.log("fal request:", result.request_id);
  } catch (e) {
    console.error(e);
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "❌ Gagal mengirim ke Kling/fal.ai. Cek FAL_KEY lalu coba lagi.",
    });
  }
}

async function handleFalWebhook(request, env) {
  const url = new URL(request.url);
  const chatId = url.searchParams.get("chat_id");
  if (!chatId) return json({ ok: false, error: "missing chat_id" }, 400);

  const payload = await request.json();

  if (payload.status !== "OK") {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "❌ Kling gagal membuat video. Coba lagi dengan video referensi lain.",
    });
    return json({ ok: true });
  }

  const videoUrl = payload?.payload?.video?.url;
  if (!videoUrl) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "❌ Hasil Kling tidak berisi URL video.",
    });
    return json({ ok: true });
  }

  await tg(env, "sendVideo", {
    chat_id: chatId,
    video: videoUrl,
    caption: "🔥 Jadi ngab! Kling Motion Control selesai.",
  });

  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "GET") {
        return new Response("Kling Motion Telegram Bot aktif 🔥");
      }

      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      if (url.pathname === "/fal-webhook") {
        return handleFalWebhook(request, env);
      }

      const update = await request.json();

      if (update.callback_query) {
        await handleCallback(update, env, request.url);
      } else {
        await handleTelegramUpdate(update, env);
      }

      return json({ ok: true });
    } catch (e) {
      console.error(e);
      return json({ ok: false, error: "internal error" }, 500);
    }
  },
};
