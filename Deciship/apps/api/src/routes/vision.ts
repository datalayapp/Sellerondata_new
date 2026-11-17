import { m } from '../i18n/index.ts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.ts';
import { env } from '../env.ts';
import { AppError, badRequest, emptyFile } from '../errors.ts';
import { readSettings } from '../lib/settings.ts';
import { readScale } from '../services/ai.ts';
import { aiContext, registerAiErrorHeaders } from '../services/aiMeter.ts';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const point = z.tuple([z.number().finite(), z.number().finite()]);
const solveBody = z.object({
  detectId: z.string().optional(),
  imageSize: z.object({ w: z.number().positive().max(100_000), h: z.number().positive().max(100_000) }),
  marker: z.object({ corners: z.array(point).length(4), id: z.number().int().optional() }).passthrough(),
  intrinsics: z.record(z.string(), z.unknown()).nullable().optional(),
  points: z.array(point).min(3).max(64),
});

async function readImage(req: FastifyRequest) {
  if (!req.isMultipart()) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', m('vision.photoNotSent'));
  const file = await req.file({ limits: { fileSize: MAX_IMAGE_BYTES } });
  if (!file) throw badRequest('VALIDATION', m('vision.photoNotSelected'));
  const buffer = await file.toBuffer();
  if (!buffer.length) throw emptyFile();
  if (!file.mimetype.startsWith('image/')) throw badRequest('INVALID_FILE', m('vision.notPhoto'));
  return { buffer, mime: file.mimetype, fileName: file.filename || 'image.jpg' };
}

/** Görüntü servisi Türkçe metin döner (services/vision/app/main.py). API koda ve isteğin diline çevirir. */
const VISION_MESSAGE_CODES = ['NO_MARKER', 'BAD_IMAGE', 'TOO_LARGE', 'BLURRY', 'BOX_FOUND', 'BOX_DEFAULT', 'BAD_POINTS'] as const;

function visionCodeOf(text: unknown) {
  return VISION_MESSAGE_CODES.find((code) => m(`vision.${code}`, undefined, 'tr') === text);
}

/** Yanıttaki `message` isteğin dilinde, yanında `messageCode`. */
function localizeVisionBody(body: unknown) {
  if (!body || typeof body !== 'object' || !('message' in body)) return body;
  const code = visionCodeOf((body as { message: unknown }).message);
  return code ? { ...body, message: m(`vision.${code}`), messageCode: code } : body;
}

function visionUnavailable() {
  return new AppError(503, 'VISION_UNAVAILABLE', m('vision.unavailable'));
}

async function forward(pathName: string, init: RequestInit) {
  let res: Response;
  try {
    res = await fetch(`${env.visionUrl}${pathName}`, { ...init, signal: AbortSignal.timeout(60_000) });
  } catch {
    throw visionUnavailable();
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AppError(502, 'VISION_FAILED', m('vision.badResponse'));
  }
  if (!res.ok && res.status < 500 && body && typeof body === 'object' && 'ok' in body) return localizeVisionBody(body);
  if (!res.ok) {
    const detail = (body as { detail?: unknown; message?: unknown })?.detail ?? (body as { message?: unknown })?.message;
    const code = visionCodeOf(detail);
    throw new AppError(res.status >= 500 ? 502 : 422, 'VISION_FAILED', code ? m(`vision.${code}`) : m('vision.failed'), code ? { messageCode: code } : undefined);
  }
  return localizeVisionBody(body);
}

export async function visionRoutes(app: FastifyInstance) {
  const capture = { onRequest: app.requirePermission('deciship.measurements.capture') };
  registerAiErrorHeaders(app);

  app.post('/vision/scale', capture, async (req) => {
    // Kullanıcı kararı 2026-11-12: tartı okuması firma ayarıyla açılır (varsayılan kapalı). Kapalıysa fotoğraf okunmaz,
    // sağlayıcıya ve sayaca gidilmez (ücret, kota, önbellek yok); telefon ağırlığı elle aldırır. Kod `AI_DISABLED`: eski mobil
    // sürümler de bu kodu "Otomatik okuma kapalı. Ağırlığı elle girin." diye gösterir; nedeni `details.reason`.
    const company = await prisma.company.findFirstOrThrow({ where: { id: req.auth.orgId }, select: { settings: true } });
    if (!readSettings(company.settings).scaleAiRead) throw new AppError(409, 'AI_DISABLED', m('ai.scaleReadOff'), { reason: 'scale_ai_off' });
    const img = await readImage(req);
    return readScale(img.buffer, img.mime, aiContext(req, 'SCALE_READ'));
  });

  app.post('/vision/reference/detect', capture, async (req) => {
    const img = await readImage(req);
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(img.buffer)], { type: img.mime }), img.fileName);
    return forward('/detect', { method: 'POST', body: form });
  });

  app.post('/vision/reference/solve', capture, async (req) => {
    const body = solveBody.parse(req.body);
    return forward('/solve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  });
}
