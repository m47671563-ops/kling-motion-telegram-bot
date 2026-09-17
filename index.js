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

  return `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
}

function getPhotoId(message) {
  const photos = message?.photo;

  if (!photos?.length) {
    return null;
  }

  return photos[photos.length - 1].file_id;
}

function getVideoId(message) {
  if (message?.video?.file_id) {
    return message.video.file_id;
  }

  if (message?.document?.mime_type?.startsWith("video/")) {
    return message.document.file_id;
  }

  return null;
}

function extractImageIdFromReply(message) {
  const text = message?.reply_to_message?.text || "";

  const match = text.match(/^IMG:([A-Za-z0-9_-]+)$/m);

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

  const data = await r.json();

  if (!r.ok) {
    throw new Error(
      `fal submit failed: ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function handleTelegramUpdate(update, env) {
  const message = update.message;

  if (!message) {
    return;
  }

  const chatId = message.chat.id;

  // =========================
  // START / HELP
  // =========================

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

  // =========================
  // FOTO
  // =========================

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

  // =========================
  // VIDEO
  // =========================

  const videoId = getVideoId(message);

  if (videoId) {
    const imageId = extractImageIdFromReply(message);

    if (!imageId) {
      await tg(env, "sendMessage", {
        chat_id: chatId,

        text:
          "⚠️ Reply pesan bot dengan video " +
          "supaya foto dan video bisa dipasangkan.",
      });

      return;
    }

    /*
      PENTING:

      Jangan memasukkan imageId + videoId ke callback_data.

      Telegram punya batas panjang callback_data.
      Jadi tombol hanya mengirim:

      gen|image
      gen|video

      ID foto dan video disimpan di TEXT pesan Telegram.
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
              callback_data: "gen|image",
            },

            {
              text: "🎥 Video",
              callback_data: "gen|video",
            },
          ],
        ],
      },
    });

    return;
  }
}

async function handleCallback(
  update,
  env,
  requestUrl
) {
  const q = update.callback_query;

  if (!q?.data) {
    return;
  }

  await tg(env, "answerCallbackQuery", {
    callback_query_id: q.id,
  });

  const parts = q.data.split("|");

  if (
    parts.length !== 2 ||
    parts[0] !== "gen"
  ) {
    return;
  }

  const orientation = parts[1];

  const chatId = q.message.chat.id;

  /*
    Ambil IMG dan VID dari text pesan
    yang mempunyai tombol.
  */

  const text = q.message?.text || "";

  const imageMatch = text.match(
    /IMG:([A-Za-z0-9_-]+)/
  );

  const videoMatch = text.match(
    /VID:([A-Za-z0-9_-]+)/
  );

  const imageId = imageMatch
    ? imageMatch[1]
    : null;

  const videoId = videoMatch
    ? videoMatch[1]
    : null;

  if (!imageId || !videoId) {
    await tg(env, "sendMessage", {
      chat_id: chatId,

      text:
        "❌ Data foto/video tidak ditemukan.\n\n" +
        "Kirim ulang foto dan video ya ngab.",
    });

    return;
  }

  // =========================
  // STATUS PROSES
  // =========================

  await tg(env, "sendMessage", {
    chat_id: chatId,

    text:
      "⏳ Oke ngab, Kling lagi proses.\n\n" +
      "Tunggu sampai videonya jadi ya 🔥",
  });

  try {
    // =========================
    // TELEGRAM FILE URL
    // =========================

    const imageUrl =
      await getTelegramFileUrl(
        env,
        imageId
      );

    const videoUrl =
      await getTelegramFileUrl(
        env,
        videoId
      );

    // =========================
    // FAL WEBHOOK
    // =========================

    const callbackUrl =
      `${new URL(requestUrl).origin}` +
      `/fal-webhook?chat_id=` +
      `${encodeURIComponent(chatId)}`;

    // =========================
    // KIRIM KE FAL / KLING
    // =========================

    const result = await submitFal(
      env,
      imageUrl,
      videoUrl,
      orientation,
      callbackUrl
    );

    console.log(
      "FAL REQUEST:",
      result.request_id
    );

  } catch (e) {
    console.error(e);

    await tg(env, "sendMessage", {
      chat_id: chatId,

      text:
        "❌ Gagal mengirim ke Kling/fal.ai.\n\n" +
        "Cek koneksi FAL_KEY lalu coba lagi.",
    });
  }
}

async function handleFalWebhook(
  request,
  env
) {
  const url = new URL(request.url);

  const chatId =
    url.searchParams.get("chat_id");

  if (!chatId) {
    return json(
      {
        ok: false,
        error: "missing chat_id",
