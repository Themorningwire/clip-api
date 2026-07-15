/**
 * ClipGrab clip-processor API
 * ----------------------------
 * Takes { youtube_url, start_time, end_time, include_subtitles },
 * uses yt-dlp (with --download-sections, so it never pulls the full video)
 * plus ffmpeg to cut exactly that range, optionally pulls subtitles as .srt,
 * and exposes the result as downloadable files.
 *
 * Deploy this on Railway / Render / Fly.io — NOT on a Supabase edge function
 * (those can't run yt-dlp/ffmpeg binaries).
 *
 * Env vars:
 *   CLIP_API_KEY   - required. Requests must send header: x-api-key: <value>
 *   PORT           - optional, defaults to 3000
 *   PUBLIC_BASE_URL- optional. Base URL used to build file download links
 *                    (e.g. https://your-app.up.railway.app). If unset, the
 *                    server infers it from the request.
 *
 * Requires yt-dlp and ffmpeg to be installed in the deploy environment.
 * See Dockerfile for a ready-made image that installs both.
 */

const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.CLIP_API_KEY;
const WORK_DIR = path.join(__dirname, "jobs");
const MAX_CLIP_SECONDS = 60 * 30; // 30 min safety cap

if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

// In-memory job store. Fine for a small single-instance deploy.
// Swap for Redis/DB if you scale to multiple instances.
const jobs = new Map();

// ---------- helpers ----------

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    return res.status(500).json({ error: "Server misconfigured: CLIP_API_KEY not set" });
  }
  const key = req.header("x-api-key");
  if (key !== API_KEY) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }
  next();
}

// Accepts "mm:ss", "hh:mm:ss", or plain seconds. Returns seconds (number).
function parseTimeToSeconds(t) {
  if (typeof t === "number") return t;
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const parts = t.split(":").map(Number);
  if (parts.some(isNaN)) throw new Error(`Invalid time value: ${t}`);
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + p;
  return seconds;
}

function secondsToTimestamp(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

function isValidYoutubeUrl(url) {
  try {
    const u = new URL(url);
    return (
      /(^|\.)youtube\.com$/.test(u.hostname) || u.hostname === "youtu.be"
    );
  } catch {
    return false;
  }
}

function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, opts);
    let stderr = "";
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with code ${code}\n${stderr}`));
    });
    proc.on("error", reject);
  });
}

function baseUrlFor(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
}

// ---------- core processing ----------

async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  const jobDir = path.join(WORK_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    job.status = "processing";

    const { youtube_url, start_seconds, end_seconds, include_subtitles } = job;
    const section = `*${secondsToTimestamp(start_seconds)}-${secondsToTimestamp(end_seconds)}`;

    const outputTemplate = path.join(jobDir, "clip.%(ext)s");

    const args = [
      youtube_url,
      "--download-sections", section,
      "--force-keyframes-at-cuts",
      "-f", "bv*+ba/b",
      "--merge-output-format", "mp4",
      "-o", outputTemplate,
      "--no-playlist",
      "--newline",
    ];

    if (include_subtitles) {
      args.push(
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs", "en.*",
        "--convert-subs", "srt"
      );
    }

    await runCommand("yt-dlp", args);

    const files = fs.readdirSync(jobDir);
    const videoFile = files.find((f) => f.endsWith(".mp4"));
    const subFile = files.find((f) => f.endsWith(".srt"));

    if (!videoFile) {
      throw new Error("yt-dlp did not produce an output video file");
    }

    job.videoFile = videoFile;
    job.subFile = subFile || null;
    job.status = "done";
  } catch (err) {
    job.status = "failed";
    job.error = err.message.slice(0, 2000);
  }
}

// ---------- routes ----------

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/jobs", requireApiKey, async (req, res) => {
  const { youtube_url, start_time, end_time, include_subtitles } = req.body || {};

  if (!youtube_url || !isValidYoutubeUrl(youtube_url)) {
    return res.status(400).json({ error: "Missing or invalid youtube_url" });
  }

  let start_seconds, end_seconds;
  try {
    start_seconds = parseTimeToSeconds(start_time);
    end_seconds = parseTimeToSeconds(end_time);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  if (start_seconds < 0 || end_seconds <= start_seconds) {
    return res.status(400).json({ error: "end_time must be after start_time" });
  }
  if (end_seconds - start_seconds > MAX_CLIP_SECONDS) {
    return res.status(400).json({ error: `Clip too long. Max ${MAX_CLIP_SECONDS / 60} minutes.` });
  }

  const jobId = uuidv4();
  jobs.set(jobId, {
    id: jobId,
    youtube_url,
    start_seconds,
    end_seconds,
    include_subtitles: !!include_subtitles,
    status: "pending",
    createdAt: Date.now(),
  });

  // Fire and forget; client polls GET /jobs/:id
  processJob(jobId);

  res.status(202).json({ job_id: jobId, status: "pending" });
});

app.get("/jobs/:id", requireApiKey, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });

  const base = baseUrlFor(req);
  const response = {
    job_id: job.id,
    status: job.status,
  };

  if (job.status === "done") {
    response.output_video_url = `${base}/files/${job.id}/${job.videoFile}`;
    response.output_subtitle_url = job.subFile
      ? `${base}/files/${job.id}/${job.subFile}`
      : null;
  }
  if (job.status === "failed") {
    response.error = job.error;
  }

  res.json(response);
});

// Serve output files. API-key protected so clips aren't publicly world-readable.
app.get("/files/:jobId/:filename", requireApiKey, (req, res) => {
  const { jobId, filename } = req.params;
  const filePath = path.join(WORK_DIR, jobId, filename);
  if (!filePath.startsWith(WORK_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  res.download(filePath);
});

// Basic cleanup: delete job dirs older than 2 hours, checked hourly.
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (job.createdAt < cutoff) {
      fs.rmSync(path.join(WORK_DIR, id), { recursive: true, force: true });
      jobs.delete(id);
    }
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Clip API listening on port ${PORT}`);
});
