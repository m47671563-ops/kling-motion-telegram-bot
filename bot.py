import asyncio
import logging
import os
import tempfile
from pathlib import Path

import fal_client
from dotenv import load_dotenv
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

load_dotenv()

TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
FAL_KEY = os.getenv("FAL_KEY")

MODEL = "fal-ai/kling-video/v3/standard/motion-control"

logging.basicConfig(
    format="%(asctime)s | %(levelname)s | %(message)s",
    level=logging.INFO,
)

STATE = {}

if not TOKEN or not FAL_KEY:
    raise RuntimeError("TELEGRAM_BOT_TOKEN dan FAL_KEY wajib diisi.")

PROMPTS = {
    "natural": (
        "A relaxed fashion lifestyle moment. "
        "Subtle natural body movement, gentle breathing, "
        "small weight shift and relaxed expression. "
        "Understated realistic motion."
    ),
    "pose": (
        "A simple cool fashion pose. "
        "Small natural body shift, slight head movement, "
        "relaxed hands and confident expression. "
        "Smooth restrained motion."
    ),
    "walk": (
        "A relaxed fashion walk with natural posture "
        "and subtle body movement. Calm realistic pace "
        "and natural fabric motion."
    ),
}


def presets():
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton(
                "🌿 Natural Tipis",
                callback_data="preset:natural",
            ),
            InlineKeyboardButton(
                "😎 Cool Pose",
                callback_data="preset:pose",
            ),
        ],
        [
            InlineKeyboardButton(
                "🚶 Jalan Pelan",
                callback_data="preset:walk",
            ),
            InlineKeyboardButton(
                "✍️ Custom",
                callback_data="preset:custom",
            ),
        ],
    ])


def orientations():
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton(
                "🖼️ Ikuti orientasi foto",
                callback_data="orientation:image",
            )
        ],
        [
            InlineKeyboardButton(
                "🎥 Ikuti orientasi video",
                callback_data="orientation:video",
            )
        ],
    ])


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    STATE[update.effective_user.id] = {}
    await update.message.reply_text(
        "🔥 KLING MOTION 3.0 BOT\n\n"
        "1. Kirim FOTO model/produk 📸\n"
        "2. Kirim VIDEO referensi gerakan 🎥\n"
        "3. Pilih preset gerakan\n\n"
        "Untuk hasil sekitar 4 detik, gunakan video referensi "
        "sekitar 4 detik."
    )


async def photo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uid = update.effective_user.id
    state = STATE.setdefault(uid, {})

    telegram_file = await context.bot.get_file(
        update.message.photo[-1].file_id
    )

    tmp = tempfile.NamedTemporaryFile(
        delete=False,
        suffix=".jpg",
    )
    tmp.close()

    await telegram_file.download_to_drive(tmp.name)

    state["image"] = tmp.name

    await update.message.reply_text(
        "✅ Foto masuk.\n\n"
        "Sekarang kirim VIDEO referensi gerakan 🎥"
    )


async def video(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uid = update.effective_user.id
    state = STATE.setdefault(uid, {})

    if "image" not in state:
        await update.message.reply_text(
            "Kirim FOTO dulu ngab 📸"
        )
        return

    obj = update.message.video or update.message.document
    telegram_file = await context.bot.get_file(obj.file_id)

    suffix = ".mp4"
    if (
        update.message.document
        and update.message.document.file_name
    ):
        suffix = (
            Path(update.message.document.file_name).suffix
            or ".mp4"
        )

    tmp = tempfile.NamedTemporaryFile(
        delete=False,
        suffix=suffix,
    )
    tmp.close()

    await telegram_file.download_to_drive(tmp.name)

    state["video"] = tmp.name

    await update.message.reply_text(
        "✅ Video masuk.\n\n"
        "Pilih gerakan:",
        reply_markup=presets(),
    )


async def preset(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
):
    query = update.callback_query
    await query.answer()

    uid = query.from_user.id
    state = STATE.setdefault(uid, {})

    selected = query.data.split(":", 1)[1]
    state["preset"] = selected

    if selected == "custom":
        state["custom"] = True
        await query.message.reply_text(
            "✍️ Ketik gerakan custom.\n\n"
            "Contoh:\n"
            "sedikit menoleh ke samping lalu memegang "
            "ujung cardigan secara natural."
        )
        return

    await query.message.reply_text(
        "Pilih orientasi karakter:",
        reply_markup=orientations(),
    )


async def text(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
):
    uid = update.effective_user.id
    state = STATE.get(uid, {})

    if state.get("custom"):
        state["custom_prompt"] = update.message.text.strip()
        state["custom"] = False

        await update.message.reply_text(
            "✅ Custom tersimpan.\n\n"
            "Sekarang pilih orientasi:",
            reply_markup=orientations(),
        )
        return

    await update.message.reply_text(
        "Ketik /start untuk mulai dari awal."
    )


def generate(state):
    image_url = fal_client.upload_file(state["image"])
    video_url = fal_client.upload_file(state["video"])

    preset_name = state.get("preset", "natural")
    prompt = state.get(
        "custom_prompt",
        PROMPTS.get(preset_name, PROMPTS["natural"]),
    )

    result = fal_client.subscribe(
        MODEL,
        arguments={
            "prompt": prompt,
            "image_url": image_url,
            "video_url": video_url,
            "character_orientation": state.get(
                "orientation",
                "video",
            ),
            "keep_original_sound": True,
        },
    )

    return result["video"]["url"]


async def orientation(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
):
    query = update.callback_query
    await query.answer()

    uid = query.from_user.id
    state = STATE.get(uid, {})

    if "image" not in state or "video" not in state:
        await query.message.reply_text(
            "Foto + video belum lengkap. "
            "Ketik /start."
        )
        return

    state["orientation"] = query.data.split(":", 1)[1]

    await query.message.reply_text(
        "⏳ Lagi generate Kling 3.0 Motion Control...\n"
        "Tunggu sebentar ngab 🔥"
    )

    try:
        video_url = await asyncio.to_thread(
            generate,
            state,
        )

        await query.message.reply_video(
            video=video_url,
            caption="🔥 Selesai ngab! Kling Motion 3.0",
        )

    except Exception as exc:
        logging.exception("Generate error")
        await query.message.reply_text(
            "❌ Generate gagal.\n"
            f"Detail: {exc}"
        )


async def error(update, context):
    logging.exception(
        "Unhandled error",
        exc_info=context.error,
    )


def main():
    app = Application.builder().token(TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(
        CallbackQueryHandler(
            preset,
            pattern=r"^preset:",
        )
    )
    app.add_handler(
        CallbackQueryHandler(
            orientation,
            pattern=r"^orientation:",
        )
    )
    app.add_handler(
        MessageHandler(
            filters.PHOTO,
            photo,
        )
    )
    app.add_handler(
        MessageHandler(
            filters.VIDEO | filters.Document.VIDEO,
            video,
        )
    )
    app.add_handler(
        MessageHandler(
            filters.TEXT & ~filters.COMMAND,
            text,
        )
    )

    app.add_error_handler(error)

    port = int(os.getenv("PORT", "10000"))
    external_url = os.getenv("RENDER_EXTERNAL_URL")

    if not external_url:
        raise RuntimeError(
            "RENDER_EXTERNAL_URL tidak tersedia"
        )

    webhook_path = "/telegram"
    webhook_url = (
        external_url.rstrip("/")
        + webhook_path
    )

    print("Kling Motion Telegram Bot aktif.")
    print("Webhook URL:", webhook_url)

    app.run_webhook(
        listen="0.0.0.0",
        port=port,
        url_path=webhook_path.lstrip("/"),
        webhook_url=webhook_url,
        drop_pending_updates=True,
    )


if __name__ == "__main__":
    main()
    
