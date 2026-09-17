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
  const r = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  const data = await r.json();

  if (!data.ok) {
    throw new Error(
      `Telegram ${method}: ${JSON.stringify(data)}`
    );
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

  if (
    message?.document?.mime_type &&
    message.document.mime_type.startsWith("video/")
  ) {
    return message.document.file_id;
  }

  return null;
}

function extractImageId(text) {
  if (!text) {
    return null;
  }

  const match = text.match(/IMG:([A-Za-z0-9_-]+)/);

  return match ? match[1] : null;
}

function extractVideoId(text) {
  if (!text) {
    return null;
  }

  const match = text.match(/VID:([A-Za-z0-9_-]+)/);

  return match ? match[1] : null;
}

async function submitFal(
  env,
  imageUrl,
  videoUrl,
  orientation,
  callbackUrl
) {
  const response = await fetch(
    `https://queue.fal.run/${MODEL}`,
    {
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
    }
  );

  const data = await response.json();

  if (!response.ok) {
  throw new Error(
    `fal submit failed | HTTP ${response.status} | ${JSON.stringify(data)}`
  );
}

  return data;
}

async function handleTelegramUpdate(update, env) {
  const message = update?.message;

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
        "Cara pakai:\n" +
        "1️⃣ Kirim FOTO karakter/pakaian.\n" +
        "2️⃣ Bot akan membalas pesan foto.\n" +
        "3️⃣ Reply pesan bot tersebut dengan VIDEO referensi gerakan.\n" +
        "4️⃣ Pilih orientasi Image atau Video.\n\n" +
        "🚀 Nanti hasil Kling dikirim balik ke sini.",
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
        "📸 Foto diterima ngab!\n\n" +
        "Sekarang kirim VIDEO referensi gerakan dengan cara REPLY pesan ini.\n\n" +
        `IMG:${photoId}`,
    });

    return;
  }

  // =========================
  // VIDEO
  // =========================

  const videoId = getVideoId(message);

  if (videoId) {
    const replyText =
      message?.reply_to_message?.text || "";

    const imageId = extractImageId(replyText);

    if (!imageId) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text:
          "⚠️ Video diterima, tapi fotonya belum ketemu.\n\n" +
          "Kirim foto dulu, lalu REPLY pesan bot dengan video.",
      });

      return;
    }

    await tg(env, "sendMessage", {
      chat_id: chatId,

      text:
        "🎬 Video diterima!\n\n" +
        `IMG:${imageId}\n` +
        `VID:${videoId}\n\n` +
        "Pilih orientasi Kling:",

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

async function handleCallback(
  update,
  env,
  requestUrl
) {
  const query = update?.callback_query;

  if (!query?.data) {
    return;
  }

  await tg(env, "answerCallbackQuery", {
    callback_query_id: query.id,
  });

  const orientation = query.data;

  if (
    orientation !== "image" &&
    orientation !== "video"
  ) {
    return;
  }

  const message = query.message;

  if (!message) {
    return;
  }

  const chatId = message.chat.id;
  const messageText = message.text || "";

  const imageId = extractImageId(messageText);
  const videoId = extractVideoId(messageText);

  if (!imageId || !videoId) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "❌ Data foto/video tidak ditemukan.\n" +
        "Coba ulangi dari awal dengan /start",
    });

    return;
  }

  await tg(env, "sendMessage", {
    chat_id: chatId,
    text:
      "⏳ Oke ngab 🔥\n\n" +
      "Kling lagi memproses motion control...\n" +
      "Tunggu sampai videonya selesai ya.",
  });

  try {
    const imageUrl = await getTelegramFileUrl(
      env,
      imageId
    );

    const videoUrl = await getTelegramFileUrl(
      env,
      videoId
    );

    const callbackUrl =
      `${new URL(requestUrl).origin}` +
      `/fal-webhook?chat_id=` +
      encodeURIComponent(chatId);

    const result = await submitFal(
      env,
      imageUrl,
      videoUrl,
      orientation,
      callbackUrl
    );

    console.log(
      "FAL REQUEST ID:",
      result?.request_id
    );

  } catch (error) {
    console.error(
      "HANDLE CALLBACK ERROR:",
      error
    );

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "❌ Gagal mengirim ke Kling/fal.ai.\n\n" +
        "Coba lagi dengan /start.",
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
      },
      400
    );
  }

  let payload;

  try {
    payload = await request.json();
  } catch (error) {
    console.error(
      "INVALID FAL WEBHOOK JSON:",
      error
    );

    return json(
      {
        ok: false,
        error: "invalid json",
      },
      400
    );
  }

  console.log(
    "FAL WEBHOOK:",
    JSON.stringify(payload)
  );

  // =========================
  // KLING GAGAL
  // =========================

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

  // =========================
  // AMBIL VIDEO
  // =========================

  const videoUrl =
    payload?.payload?.video?.url ||
    payload?.video?.url;

  if (!videoUrl) {
    console.error(
      "HASIL KLING TIDAK ADA VIDEO URL:",
      JSON.stringify(payload)
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

  // =========================
  // KIRIM VIDEO KE TELEGRAM
  // =========================

  try {
    await tg(env, "sendVideo", {
      chat_id: chatId,
      video: videoUrl,
      caption:
        "🔥 Jadi ngab!\n" +
        "Kling Motion Control selesai.",
    });

  } catch (error) {
    console.error(
      "SEND VIDEO ERROR:",
      error
    );

    await tg(env, "sendMessage", {
      chat_id: chatId,
      text:
        "✅ Kling sudah selesai membuat video,\n" +
        "tapi Telegram gagal mengirim videonya.",
    });
  }

  return json({
    ok: true,
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      // =========================
      // TEST BROWSER
      // =========================

      if (request.method === "GET") {
        if (url.pathname === "/fal-webhook") {
          return json({
            ok: true,
            message: "FAL webhook endpoint aktif",
          });
        }

        return new Response(
          "Kling Motion Telegram Bot aktif 🔥"
        );
      }

      // =========================
      // HANYA POST
      // =========================

      if (request.method !== "POST") {
        return new Response(
          "Method Not Allowed",
          {
            status: 405,
          }
        );
      }

      // =========================
      // FAL WEBHOOK
      // =========================

      if (
        url.pathname === "/fal-webhook"
      ) {
        return await handleFalWebhook(
          request,
          env
        );
      }

      // =========================
      // TELEGRAM WEBHOOK
      // =========================

      const update =
        await request.json();

      if (update?.callback_query) {
        await handleCallback(
          update,
          env,
          request.url
        );
      } else {
        await handleTelegramUpdate(
          update,
          env
        );
      }

      return json({
        ok: true,
      });

    } catch (error) {
      console.error(
        "WORKER ERROR:",
        error
      );

      return json(
        {
          ok: false,
          error: "internal error",
        },
        500
      );
    }
  },
};
