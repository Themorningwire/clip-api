# ClipGrab Clip API

Small server that downloads only a time range of a YouTube video (using
`yt-dlp --download-sections`, so it never fetches the whole video) and
optionally pulls subtitles as `.srt`. This is the `CLIP_API_URL` your
Lovable app calls.

## Deploy on Railway (easiest)

1. Push this folder to a GitHub repo (or use Railway's "Deploy from local
   directory" via their CLI).
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo.
   Railway auto-detects the `Dockerfile` and builds it — yt-dlp and ffmpeg
   get installed automatically, no extra setup.
3. In the Railway project's **Variables** tab, add:
   - `CLIP_API_KEY` = any long random string you make up (e.g. run
     `openssl rand -hex 32` locally, or use a password generator).
4. Deploy. Railway gives you a public URL like
   `https://clip-api-production-xxxx.up.railway.app`.
5. In Lovable's secrets form:
   - `CLIP_API_URL` = that Railway URL (e.g.
     `https://clip-api-production-xxxx.up.railway.app`)
   - `CLIP_API_KEY` = the exact same string you set in step 3.

Render works the same way — "New Web Service", point it at the repo, it
picks up the Dockerfile, add the `CLIP_API_KEY` env var, deploy.

## API contract (what your edge function should call)

### Create a job
```
POST {CLIP_API_URL}/jobs
Headers: x-api-key: {CLIP_API_KEY}
Body: {
  "youtube_url": "https://www.youtube.com/watch?v=...",
  "start_time": "01:23",       // mm:ss, hh:mm:ss, or seconds
  "end_time": "01:45",
  "include_subtitles": true
}

-> 202 { "job_id": "...", "status": "pending" }
```

### Poll status
```
GET {CLIP_API_URL}/jobs/{job_id}
Headers: x-api-key: {CLIP_API_KEY}

-> { "job_id": "...", "status": "pending" | "processing" | "done" | "failed",
     "output_video_url": "...",      // present when done
     "output_subtitle_url": "..." or null,
     "error": "..."                  // present when failed
   }
```

Your edge function should poll this every couple of seconds and copy
`output_video_url` / `output_subtitle_url` into the `clips` row, matching
the schema already described in the Lovable prompt.

## Local test

```bash
npm install
CLIP_API_KEY=test123 node server.js

curl -X POST localhost:3000/jobs \
  -H "x-api-key: test123" -H "Content-Type: application/json" \
  -d '{"youtube_url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","start_time":"0:05","end_time":"0:15","include_subtitles":false}'
```

(Requires `yt-dlp` and `ffmpeg` installed locally, or just deploy and test
against the live Docker build instead.)

## Notes / limits

- Max clip length is capped at 30 minutes in `server.js`
  (`MAX_CLIP_SECONDS`) — raise if needed.
- Jobs and files are kept in memory / local disk and auto-deleted after 2
  hours. Fine for a single small instance; swap in a DB + object storage
  (S3, Cloudflare R2) if you expect real traffic.
- Some videos won't have English subtitles/auto-captions — in that case
  `output_subtitle_url` will just come back `null` even with
  `include_subtitles: true`; worth surfacing that in the UI.
