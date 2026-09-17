
import asyncio, logging, os, tempfile
from pathlib import Path
import fal_client
from dotenv import load_dotenv
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import Application, CallbackQueryHandler, CommandHandler, ContextTypes, MessageHandler, filters

load_dotenv()
TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
FAL_KEY = os.getenv("FAL_KEY")
MODEL = "fal-ai/kling-video/v3/standard/motion-control"
logging.basicConfig(format="%(asctime)s | %(levelname)s | %(message)s", level=logging.INFO)
STATE = {}

if not TOKEN or not FAL_KEY:
    raise RuntimeError("Isi TELEGRAM_BOT_TOKEN dan FAL_KEY di .env")

PROMPTS = {
    "natural": "A relaxed fashion lifestyle moment. Subtle natural body movement, gentle breathing, small weight shift and relaxed expression. Understated realistic motion.",
    "pose": "A simple cool fashion pose. Small natural body shift, slight head movement, relaxed hands and confident expression. Smooth restrained motion.",
    "walk": "A relaxed fashion walk with natural posture and subtle body movement. Calm realistic pace and natural fabric motion.",
}

def presets():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🌿 Natural Tipis", callback_data="preset:natural"),
         InlineKeyboardButton("😎 Cool Pose", callback_data="preset:pose")],
        [InlineKeyboardButton("🚶 Jalan Pelan", callback_data="preset:walk"),
         InlineKeyboardButton("✍️ Custom", callback_data="preset:custom")]
    ])

def orientations():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🖼️ Ikuti orientasi foto", callback_data="orientation:image")],
        [InlineKeyboardButton("🎥 Ikuti orientasi video", callback_data="orientation:video")]
    ])

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    STATE[update.effective_user.id] = {}
    await update.message.reply_text(
        "🔥 KLING MOTION 3.0 BOT\n\n"
        "1. Kirim FOTO model/produk 📸\n"
        "2. Kirim VIDEO referensi gerakan 🎥\n"
        "3. Pilih preset\n\n"
        "Kalau mau hasil sekitar 4 detik, gunakan video referensi sekitar 4 detik."
    )

async def photo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uid = update.effective_user.id
    s = STATE.setdefault(uid, {})
    f = await context.bot.get_file(update.message.photo[-1].file_id)
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".jpg"); tmp.close()
    await f.download_to_drive(tmp.name)
    s["image"] = tmp.name
    await update.message.reply_text("✅ Foto masuk. Sekarang kirim VIDEO referensi gerakan 🎥")

async def video(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uid = update.effective_user.id
    s = STATE.setdefault(uid, {})
    if "image" not in s:
        await update.message.reply_text("Kirim FOTO dulu ngab 📸"); return
    obj = update.message.video or update.message.document
    f = await context.bot.get_file(obj.file_id)
    suffix = ".mp4"
    if update.message.document and update.message.document.file_name:
        suffix = Path(update.message.document.file_name).suffix or ".mp4"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix); tmp.close()
    await f.download_to_drive(tmp.name)
    s["video"] = tmp.name
    await update.message.reply_text("✅ Video masuk. Pilih gerakan:", reply_markup=presets())

async def preset(update: Update, context: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query; await q.answer()
    uid = q.from_user.id; s = STATE.get(uid, {})
    p = q.data.split(":", 1)[1]; s["preset"] = p
    if p == "custom":
        s["custom"] = True
        await q.message.reply_text("Ketik gerakan custom. Contoh: sedikit menoleh ke samping lalu memegang ujung cardigan secara natural.")
    else:
        await q.message.reply_text("Pilih orientasi karakter:", reply_markup=orientations())

async def text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uid = update.effective_user.id; s = STATE.get(uid, {})
    if s.get("custom"):
        s["custom_prompt"] = update.message.text.strip(); s["custom"] = False
        await update.message.reply_text("Custom tersimpan. Pilih orientasi:", reply_markup=orientations())
    else:
        await update.message.reply_text("Ketik /start untuk mulai dari awal.")

async def orientation(update: Update, context: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query; await q.answer()
    uid = q.from_user.id; s = STATE.get(uid, {})
    if "image" not in s or "video" not in s:
        await q.message.reply_text("Foto + video belum lengkap. Ketik /start.")
        return
    s["orientation"] = q.data.split(":", 1)[1]
    await q.message.reply_text("⏳ Lagi generate Kling 3.0 Motion Control...")
    try:
        result = await asyncio.to_thread(generate, s)
        url = result["video"]["url"]
        await q.message.reply_video(video=url, caption="🔥 Kling 3.0 Motion Control selesai")
    except Exception as e:
        logging.exception("generation failed")
        await q.message.reply_text("❌ Gagal generate:\n" + str(e)[:700])
    finally:
        cleanup(uid)

def generate(s):
    image_url = fal_client.upload_file(s["image"])
    video_url = fal_client.upload_file(s["video"])
    prompt = s.get("custom_prompt") if s.get("preset") == "custom" else PROMPTS.get(s.get("preset"), PROMPTS["natural"])
    prompt += (" Preserve identity, face, hairstyle, clothing design, colors, fabric texture and body proportions. "
               "Avoid sudden motion, warping, flickering and exaggerated advertising gestures.")
    return fal_client.subscribe(MODEL, arguments={
        "prompt": prompt,
        "image_url": image_url,
        "video_url": video_url,
        "character_orientation": s.get("orientation", "video")
    })

def cleanup(uid):
    s = STATE.pop(uid, {})
    for k in ("image", "video"):
        if s.get(k):
            try: os.unlink(s[k])
            except OSError: pass

async def error(update, context):
    logging.exception("Unhandled error", exc_info=context.error)

app = Application.builder().token(TOKEN).build()
app.add_handler(CommandHandler("start", start))
app.add_handler(CallbackQueryHandler(preset, pattern=r"^preset:"))
app.add_handler(CallbackQueryHandler(orientation, pattern=r"^orientation:"))
app.add_handler(MessageHandler(filters.PHOTO, photo))
app.add_handler(MessageHandler(filters.VIDEO | filters.Document.VIDEO, video))
app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, text))
app.add_error_handler(error)

if __name__ == "__main__":
    print("Kling Motion Telegram Bot aktif.")
    app.run_polling()
