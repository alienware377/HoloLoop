'use strict';
// ffmpeg / ffprobe helpers shared by the converter and the library scanner.
const { spawn, execFile } = require('child_process');

function unpacked(p) { return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'); }
const FFMPEG = unpacked(require('ffmpeg-static'));
const FFPROBE = unpacked(require('ffprobe-static').path);

function run(bin, args, { timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); reject(err); } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function parseRate(r) {
  if (!r || r === '0/0') return null;
  const [a, b] = String(r).split('/').map(Number);
  return b ? a / b : a;
}

// Some downloads (HLS remuxed to mp4) start their clock late, say at 62 s, and the
// container's length counts that gap. ffmpeg's -ss skips the gap, so the real picture
// is that much shorter: read the last video packets to find where it really ends.
async function pictureLength(file, start, duration) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', `${Math.max(0, duration - 40)}%`,
    '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', file], { timeout: 60000 });
  let end = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const [p, d] = line.split(',').map(Number);
    if (p + (d || 0) > end) end = p + (d || 0);
  }
  return end > start ? Math.min(duration, end - start) : duration;
}

// A frame rate ffmpeg reads back exactly. Twitch files average 79333000/1322217 (59.99999),
// which -r rounds differently from the fps filter, so colour and depth frames stopped pairing up.
function cleanRate(avg, r) {
  const a = parseRate(avg), b = parseRate(r);
  if (b && b <= 240 && (!a || Math.abs(a - b) / b < 0.002)) return `${r}`;    // steady video: its own rate
  if (!a) return '30/1';
  let best = [Math.round(a), 1];                                               // uneven video: a short fraction near the average
  for (const d of [1001, 1000, 100, 12, 10, 8, 6, 5, 4, 3, 2, 1]) {
    const n = Math.round(a * d);
    if (Math.abs(n / d - a) < Math.abs(best[0] / best[1] - a) - 1e-9) best = [n, d];
  }
  return `${best[0]}/${best[1]}`;
}

async function probe(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 60000 });
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('no video stream');
  let rot = 0;
  for (const sd of v.side_data_list || []) if (sd.rotation != null) rot = Number(sd.rotation);
  if (v.tags && v.tags.rotate) rot = -Number(v.tags.rotate);
  const swap = Math.abs(rot) % 180 === 90;
  const w = swap ? v.height : v.width, h = swap ? v.width : v.height;   // what ffmpeg outputs after autorotate
  const rateStr = cleanRate(v.avg_frame_rate, v.r_frame_rate);
  let duration = Number(j.format?.duration || v.duration || 0);
  const fd = duration, vd = Number(v.duration), start = Number(j.format?.start_time);
  const vEnd = vd + Math.max(0, (Number(v.start_time) - start) || 0);   // video end, counted from the file start like -ss
  if (vd > 0 && duration > 0) duration = Math.min(duration, vEnd);      // longer audio doesn't count
  if (start > 0.5 && start < 600 && fd > 0) duration = await pictureLength(file, start, fd).catch(() => duration);
  return { width: w, height: h, fps: parseRate(rateStr) || 30, rate: rateStr || '30/1', duration, hasAudio: !!a, audioCodec: a?.codec_name, videoCodec: v.codec_name,
    container: j.format?.format_name || '' };
}

// Picks the first hardware H.264 encoder that really works on this PC.
let encoderCache = null;
async function pickEncoder() {
  if (encoderCache) return encoderCache;
  const candidates = [
    { name: 'h264_nvenc', args: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '20', '-b:v', '0'] },
    { name: 'h264_qsv', args: ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', '21'] },
    { name: 'h264_amf', args: ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '19', '-qp_p', '21'] },
    { name: 'libx264', args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '19'] },
  ];
  for (const c of candidates) {
    try {
      await run(FFMPEG, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=1280x720:d=0.2', '-pix_fmt', 'yuv420p', ...c.args, '-f', 'null', '-'], { timeout: 20000 });
      encoderCache = c; return c;
    } catch {}
  }
  encoderCache = candidates[candidates.length - 1];
  return encoderCache;
}

// HEVC at a set bitrate, for the small copies the phone plays. args(mbps) -> ffmpeg arguments.
let smallCache = null;
async function pickSmallEncoder() {
  if (smallCache) return smallCache;
  const kbps = (m) => `${Math.round(m * 1000)}k`;
  const cands = [
    { name: 'hevc_nvenc', args: (m) => ['-c:v', 'hevc_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-b:v', kbps(m), '-maxrate', kbps(m * 1.6), '-bufsize', kbps(m * 2), '-spatial-aq', '1'] },
    { name: 'hevc_qsv', args: (m) => ['-c:v', 'hevc_qsv', '-preset', 'slow', '-b:v', kbps(m), '-maxrate', kbps(m * 1.6)] },
    { name: 'hevc_amf', args: (m) => ['-c:v', 'hevc_amf', '-quality', 'quality', '-rc', 'vbr_peak', '-b:v', kbps(m), '-maxrate', kbps(m * 1.6)] },
    { name: 'libx265', args: (m) => ['-c:v', 'libx265', '-preset', 'fast', '-b:v', kbps(m), '-maxrate', kbps(m * 1.6), '-bufsize', kbps(m * 2)] },
  ];
  for (const c of cands) {
    try {
      await run(FFMPEG, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=2560x720:d=0.2', '-pix_fmt', 'yuv420p', ...c.args(4), '-f', 'null', '-'], { timeout: 20000 });
      smallCache = c; return c;
    } catch {}
  }
  smallCache = cands[cands.length - 1];
  return smallCache;
}

module.exports = { FFMPEG, FFPROBE, run, probe, pickEncoder, pickSmallEncoder, spawn };
