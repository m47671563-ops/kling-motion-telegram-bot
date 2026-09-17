const MODEL = "fal-ai/kling-video/v3/standard/motion-control";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function tg(env, method, body) {
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
    method,
    status: r.status,
    response: raw,
  });

  if (!r.ok) {
    throw new Error(`Telegram HTTP ${r.status}: ${raw}`);
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Telegram returned invalid JSON: ${raw}`);
  }

  if (!data.ok) {
    throw new Error(`Telegram API error: ${raw}`);
  }

  return data.result;
}

async function getTelegramFileUrl(env, fileId) {
  const file = await tg(env, "getFile", {
    file_id: fileId,
  });

  if (!file?.file_path) {
    throw new Error("Telegram file_path tidak ditemukan");
  }

  return (
    `https://api.telegram.org/file/bot` +
    `${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`
  );
}

function getPhotoId(message) {
  const photos = message?.photo;

  if (!photos || !photos.length) {
    return null;
  }

  return photos[photos.length - 1].file_id;
}

function getVideoId(message) {
  if (message?.video?.file_id) {
    return message.video.file_id;
  }

  if (
    message?.document?.mime_type &&
    message.document.mime_type.startsWith("video/")
  ) {
    return message.document.file_id;
  }

  return null;
}

function extractImageIdFromReply(message) {
  const text = message?.reply_to_message?.text || "";

  const match = text.match(/IMG:([A-Za-z0-9_-]+)/);

  return match ? match[1] : null;
}

async function submitFal(
  env,
  imageUrl,
  videoUrl,
  orientation,
  callbackUrl
) {
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

  const raw = await r.text();

  console.log("FAL SUBMIT RESPONSE", {
    status: r.status,
    response: raw,
  });

  if (!r.ok) {
    throw new Error(`fal submit failed: ${raw}`);
  }

  return JSON.parse(raw);
}

async function handleTelegramUpdate(update, env) {
  const message = update?.message;

  if (!message) {
    return;
  }

  const chatId = message.chat.id;

  if (
    message.text === "/start" ||
    message.text === "/help"
  ) {
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
        "Sekarang kirim VIDEO referensi gerakan " +
        "dengan cara Reply pesan ini.\n\n" +
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
        text:
          "⚠️ Video belum dipasangkan dengan foto.\n\n" +
          "Silakan Reply pesan bot yang berisi IMG: dengan video.",
      });

      return;
    }

    /*
      Callback data sengaja dibuat pendek.
      Telegram membatasi callback_data maksimal 64 byte.
    */

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "🎬 Video diterima!\n\n" +
        `IMG:${imageId}\n` +
        `VID:${videoId}\n\n` +
        "Pilih orientasi:",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🖼️ Image",
              callback_data: "image",
            },
            {
              text: "🎥 Video",
              callback_data: "video",
            },
          ],
        ],
      },
    });

    return;
  }
}

function extractIdsFromCallbackMessage(message) {
  const text = message?.text || "";

  const imageMatch = text.match(/IMG:([A-Za-z0-9_-]+)/);
  const videoMatch = text.match(/VID:([A-Za-z0-9_-]+)/);

  return {
    imageId: imageMatch ? imageMatch[1] : null,
    videoId: videoMatch ? videoMatch[1] : null,
  };
}

async function handleCallback(update, env, requestUrl) {
  const q = update?.callback_query;

  if (!q?.data) {
    return;
  }

  await tg(env, "answerCallbackQuery", {
    callback_query_id: q.id,
  });

  const orientation = q.data;

  if (
    orientation !== "image" &&
    orientation !== "video"
  ) {
    return;
  }

  const chatId = q.message.chat.id;

  const ids = extractIdsFromCallbackMessage(q.message);

  if (!ids.imageId || !ids.videoId) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "❌ ID foto/video tidak ditemukan.\n" +
        "Silakan kirim ulang foto dan video.",
    });

    return;
  }

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      "⏳ Oke ngab, Kling lagi proses.\n\n" +
      "Tunggu sampai videonya jadi ya 🔥",
  });

  try {
    const imageUrl = await getTelegramFileUrl(
      env,
      ids.imageId
    );

    const videoUrl = await getTelegramFileUrl(
      env,
      ids.videoId
    );

    const callbackUrl =
      `${new URL(requestUrl).origin}` +
      `/fal-webhook?chat_id=` +
      `${encodeURIComponent(chatId)}`;

    const result = await submitFal(
      env,
      imageUrl,
      videoUrl,
      orientation,
      callbackUrl
    );

    console.log("FAL REQUEST ID:", result?.request_id);

  } catch (e) {
    console.error("HANDLE CALLBACK ERROR:", e);

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "❌ Gagal mengirim ke Kling/fal.ai.\n\n" +
        "Coba lagi ya ngab.",
    });
  }
}

async function handleFalWebhook(request, env) {
  const url = new URL(request.url);

  const chatId = url.searchParams.get("chat_id");

  if (!chatId) {
    return json(
      {
        ok: false,
        error: "missing chat_id",
      },
      400
    );
  }

  let payload;

  try {
    payload = await request.json();
  } catch (e) {
    console.error("INVALID FAL WEBHOOK JSON:", e);

    return json(
      {
        ok: false,
        error: "invalid json",
      },
      400
    );
  }

  console.log("FAL WEBHOOK:", payload);

  if (payload?.status !== "OK") {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "❌ Kling gagal membuat video.\n\n" +
        "Coba lagi dengan video referensi lain.",
    });

    return json({
      ok: true,
    });
  }

  const videoUrl =
    payload?.payload?.video?.url ||
    payload?.video?.url;

  if (!videoUrl) {
    console.error(
      "HASIL KLING TIDAK ADA VIDEO URL:",
      payload
    );

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "❌ Hasil Kling tidak berisi URL video.",
    });

    return json({
      ok: true,
    });
  }

  try {
    await tg(env, "sendVideo",
