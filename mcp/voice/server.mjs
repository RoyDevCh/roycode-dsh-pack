// server.mjs - Voice input/output as an MCP stdio server (Windows).
// voice_record: ffmpeg dshow mic capture -> faster-whisper transcription
//   (reuses ~/.dsh/media-parse/fw-transcribe.py).
// voice_speak:  Windows SAPI speech synthesis (PowerShell System.Speech).
// voice_devices: list detected audio input devices.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const PROTOCOL_VERSION = '2024-11-05'
const TRANSCRIBE_SCRIPT = 'C:/Users/rjq51/.dsh/media-parse/fw-transcribe.py'
const DEFAULT_SECONDS = 10
const MAX_SECONDS = 120

function detectDevices() {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => { err += d })
    child.on('close', () => {
      const devices = []
      const re = /"([^"]+)"\s+\(audio\)/g
      let m
      while ((m = re.exec(err)) !== null) devices.push(m[1])
      resolve(devices)
    })
    child.on('error', () => resolve([]))
  })
}

function recordAudio(device, seconds, outPath) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-f', 'dshow', '-i', 'audio=' + device, '-t', String(seconds), '-ar', '16000', '-ac', '1', outPath]
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr.on('data', () => {})
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code))))
  })
}

function transcribe(wavPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('python', [TRANSCRIBE_SCRIPT, wavPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error('whisper exit ' + code + ': ' + err.slice(0, 300))); return }
      const segments = []
      const re = /^\[(\d+:\d+) -> (\d+:\d+)\] (.*)$/mg
      let m
      while ((m = re.exec(out)) !== null) segments.push({ start: m[1], end: m[2], text: m[3] })
      resolve({ transcript: segments.map((s) => s.text).join(' ').trim(), segments })
    })
  })
}

function speak(text) {
  const safe = String(text).replace(/"/g, "'")
  const ps = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak("' + safe + '")'
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' })
    child.on('error', () => resolve({ ok: false, error: 'powershell failed' }))
    child.on('close', (code) => resolve({ ok: code === 0 }))
  })
}

const TOOLS = [
  { name: 'voice_record', description: 'Record the microphone for N seconds (default 10, max 120) and transcribe with faster-whisper. Use when the user wants to dictate or speak input. Returns the transcript plus timed segments.', parameters: { type: 'object', additionalProperties: false, properties: { seconds: { type: 'integer', description: 'Recording length in seconds (default 10).' }, device: { type: 'string', description: 'Audio device name; defaults to the first detected device.' } } } },
  { name: 'voice_speak', description: 'Speak text aloud with the Windows SAPI voice (local TTS).', parameters: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', description: 'Text to speak.' } }, required: ['text'] } },
  { name: 'voice_devices', description: 'List detected audio input devices for voice_record.', parameters: { type: 'object', additionalProperties: false, properties: {} } },
]

async function runTool(name, args) {
  if (name === 'voice_devices') {
    return { devices: await detectDevices() }
  }
  if (name === 'voice_record') {
    const devices = await detectDevices()
    if (!devices.length) throw new Error('no audio input devices detected')
    const device = String(args.device ?? '').trim() || devices[0]
    const seconds = Math.min(Math.max(Number(args.seconds ?? DEFAULT_SECONDS), 1), MAX_SECONDS)
    const dir = mkdtempSync(path.join(tmpdir(), 'roycode-voice-'))
    const wav = path.join(dir, 'capture.wav')
    try {
      await recordAudio(device, seconds, wav)
      const result = await transcribe(wav)
      return { device, seconds, transcript: result.transcript, segments: result.segments, audio: wav }
    } catch (err) {
      throw new Error(String(err?.message ?? err))
    } finally {
      // keep the wav for the caller to reuse; cleanup on next run is acceptable
    }
  }
  if (name === 'voice_speak') {
    return await speak(args.text)
  }
  throw new Error('Unknown tool: ' + name)
}

// ── MCP stdio handler ──
const rl = readline.createInterface({ input: process.stdin, terminal: false })
let busy = Promise.resolve()
function enqueue(fn) {
  const next = busy.then(fn, fn)
  busy = next.catch(() => {})
  return next
}

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try { msg = JSON.parse(trimmed) } catch { return }
  const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
  const respondError = (code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } }) + '\n')
  if (msg.method === 'initialize') {
    respond({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'voice', version: '0.1.0' } })
    return
  }
  if (msg.method === 'notifications/initialized' || msg.method === 'ping') {
    if (msg.id !== undefined && msg.id !== null) respond({})
    return
  }
  if (msg.method === 'tools/list') {
    respond({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) })
    return
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params ?? {}
    const tool = TOOLS.find((t) => t.name === name)
    if (!tool) { respondError(-32602, 'Unknown tool: ' + name); return }
    enqueue(async () => {
      try {
        const data = await runTool(name, args ?? {})
        respond({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
      } catch (err) { respondError(-32603, String(err?.message ?? err)) }
    })
    return
  }
})
