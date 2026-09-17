
# Kling Motion Telegram Bot v1

Alur: **foto + video referensi → Kling V3 Motion Control → video kembali ke Telegram**.

Model: `fal-ai/kling-video/v3/standard/motion-control`

## Setup
1. Buat bot di Telegram lewat @BotFather dan ambil token.
2. Buat API key fal.ai dan simpan sebagai `FAL_KEY`.
3. Copy `.env.example` menjadi `.env`.
4. Isi kedua secret tersebut.
5. Install Python 3.10+ lalu:
   `pip install -r requirements.txt`
6. Jalankan:
   `python bot.py`

## Pakai
`/start` → kirim foto → kirim video referensi → pilih preset → pilih orientasi.

Untuk workflow 4 detik, gunakan video referensi sekitar 4 detik.

**Jangan kirim token Telegram atau FAL_KEY ke chat dan jangan commit `.env`.**
