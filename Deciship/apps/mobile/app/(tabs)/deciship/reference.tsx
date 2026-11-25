import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, PanResponder, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { router } from 'expo-router';
import { Trans, useTranslation } from 'react-i18next';
import Svg, { Circle, Line, Polygon, Text as SvgText } from 'react-native-svg';
import { Api, imageForm, type DetectResult, type Point, type SolveResult } from '../../../src/api/endpoints';
import { ApiError } from '../../../src/api/client';
import { useDraft } from '../../../src/draft/DraftContext';
import { Badge, Banner, Button, Footer, Header } from '../../../src/ui/components';
import { Icon } from '../../../src/ui/Icon';
import { PhotoCapture } from '../../../src/ui/PhotoCapture';
import { photoKindFor, type PhotoSource } from '../../../src/lib/photoKind';
import { colors, font, radius } from '../../../src/ui/theme';
import { fmtNum } from '../../../src/lib/format';
import { deleteQuietly, type Photo } from '../../../src/lib/images';

const LABELS = ['B1', 'B2', 'B3', 'T1', 'T2', 'T3'];
const HIT_RADIUS = 44;
const MAG = 128;
const ZOOM = 3;

/**
 * Vision kutuyu kendisi bulduysa `suggestedBox.auto` true döner; bulamazsa varsayılan yerleşim önerir.
 * Bayrağı olmayan eski vision sürümlerinde mesaj metnine ("…otomatik bulundu…") bakılır.
 */
const isAutoBox = (r: DetectResult) => {
  const box = r.suggestedBox;
  if (box?.points?.length !== 6) return false;
  if (typeof box.auto === 'boolean') return box.auto;
  return /otomatik bulundu/.test(r.message ?? '');
};

function defaultPoints(w: number, h: number): Point[] {
  const cx = w / 2;
  const cy = h * 0.55;
  const dx = w * 0.22;
  const dy = h * 0.08;
  const hh = h * 0.22;
  return [
    [cx - dx, cy],
    [cx, cy + dy],
    [cx + dx, cy],
    [cx - dx, cy - hh],
    [cx, cy + dy - hh],
    [cx + dx, cy - hh],
  ];
}

export default function Reference() {
  const { t } = useTranslation('measure');
  const { update, replacePhotoOfKind } = useDraft();
  const [camOpen, setCamOpen] = useState(true);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [source, setSource] = useState<PhotoSource>('camera');
  const [detect, setDetect] = useState<DetectResult | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [busy, setBusy] = useState<'detect' | 'solve' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [result, setResult] = useState<SolveResult | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [drag, setDrag] = useState<number | null>(null);
  /** Öneri otomatik değilse noktalar en az bir kez taşınmadan ölçülmez (varsayılan yerleşim yanlış ölçü verir). */
  const [mustMove, setMustMove] = useState(false);
  const kept = useRef(false);

  const imgSize = detect?.imageSize ?? (photo ? { w: photo.width, h: photo.height } : { w: 1, h: 1 });
  const scale = useMemo(() => {
    if (!box.w || !box.h) return 0;
    return Math.min(box.w / imgSize.w, box.h / imgSize.h);
  }, [box, imgSize.w, imgSize.h]);
  const dispW = imgSize.w * scale;
  const dispH = imgSize.h * scale;
  const offX = (box.w - dispW) / 2;
  const offY = (box.h - dispH) / 2;

  const stateRef = useRef({ points, scale, offX, offY, imgSize });
  stateRef.current = { points, scale, offX, offY, imgSize };
  const dragRef = useRef<{ idx: number; dx: number; dy: number } | null>(null);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          const { points: pts, scale: k, offX: ox, offY: oy } = stateRef.current;
          const { locationX: x, locationY: y } = e.nativeEvent;
          let best = -1;
          let bestD = HIT_RADIUS;
          pts.forEach((p, i) => {
            const d = Math.hypot(p[0] * k + ox - x, p[1] * k + oy - y);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          });
          if (best >= 0) {
            const p = pts[best]!;
            dragRef.current = { idx: best, dx: p[0] * k + ox - x, dy: p[1] * k + oy - y };
            setDrag(best);
          }
        },
        onPanResponderMove: (e) => {
          const d = dragRef.current;
          if (!d) return;
          const { scale: k, offX: ox, offY: oy, imgSize: sz } = stateRef.current;
          const { locationX: x, locationY: y } = e.nativeEvent;
          const ix = Math.max(0, Math.min(sz.w, (x + d.dx - ox) / k));
          const iy = Math.max(0, Math.min(sz.h, (y + d.dy - oy) / k));
          setPoints((prev) => prev.map((p, i) => (i === d.idx ? [ix, iy] : p)));
          setResult(null);
          setMustMove(false);
        },
        onPanResponderRelease: () => {
          dragRef.current = null;
          setDrag(null);
        },
        onPanResponderTerminate: () => {
          dragRef.current = null;
          setDrag(null);
        },
      }),
    [],
  );

  const onCapture = async (p: Photo, from: PhotoSource) => {
    setCamOpen(false);
    setSource(from);
    if (photo && !kept.current) deleteQuietly(photo.uri);
    setPhoto(p);
    setDetect(null);
    setResult(null);
    setErr(null);
    setInfo(null);
    setMustMove(false);
    setBusy('detect');
    try {
      const r = await Api.detectReference(imageForm('image', p.uri));
      const size = r.imageSize ?? { w: p.width, h: p.height };
      setDetect({ ...r, imageSize: size });
      if (!r.ok || !r.marker) {
        setErr(r.message || t('reference.cardNotFound'));
        setPoints([]);
      } else {
        const auto = isAutoBox(r);
        setPoints(r.suggestedBox?.points?.length === 6 ? r.suggestedBox.points : defaultPoints(size.w, size.h));
        setMustMove(!auto);
        if (auto && r.message) setInfo(r.message);
      }
    } catch (e) {
      setErr(e instanceof ApiError && e.isNetwork ? t('reference.needsOnline') : e instanceof ApiError && e.message ? e.message : t('reference.detectFailed'));
    } finally {
      setBusy(null);
    }
  };

  const solve = async () => {
    if (!detect?.marker || mustMove) return;
    setBusy('solve');
    setErr(null);
    try {
      const r = await Api.solveReference({
        detectId: detect.detectId,
        imageSize: detect.imageSize,
        marker: detect.marker,
        intrinsics: detect.intrinsics,
        points: points.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10] as Point),
      });
      setResult(r);
      setInfo(null);
    } catch (e) {
      setErr(e instanceof ApiError && e.message ? e.message : t('reference.solveFailed'));
    } finally {
      setBusy(null);
    }
  };

  const apply = () => {
    if (!result || !photo) return;
    const r1 = (n: number) => Math.round(Number(n) * 10) / 10;
    const a = r1(result.lengthCm);
    const b = r1(result.widthCm);
    update({
      lengthCm: Math.max(a, b),
      widthCm: Math.min(a, b),
      heightCm: r1(result.heightCm),
      dimMethod: 'REFERENCE',
      dimConfidence: result.confidence,
      boxPresetId: null,
    });
    kept.current = true;
    replacePhotoOfKind({ uri: photo.uri, kind: photoKindFor(source), width: photo.width, height: photo.height }, 'reference-photo');
    router.back();
  };

  const onLayout = (e: LayoutChangeEvent) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
  const sp = (p: Point): [number, number] => [p[0] * scale + offX, p[1] * scale + offY];
  const dragged = drag !== null ? points[drag] : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Header title={t('reference.title')} subtitle={t('reference.subtitle')} subtitleMono={false} back step={3} />
      <View style={st.stage} onLayout={onLayout}>
        {photo && scale > 0 ? (
          <>
            <Image source={{ uri: photo.uri }} style={{ position: 'absolute', left: offX, top: offY, width: dispW, height: dispH }} />
            {points.length === 6 ? (
              <View style={StyleSheet.absoluteFill} {...pan.panHandlers}>
                <Svg width={box.w} height={box.h}>
                  {detect?.marker ? (
                    <Polygon
                      points={detect.marker.corners.map((c) => sp(c).join(',')).join(' ')}
                      fill="rgba(23,178,106,0.25)"
                      stroke={MARKER}
                      strokeWidth={2}
                    />
                  ) : null}
                  {[
                    [0, 1],
                    [1, 2],
                    [3, 4],
                    [4, 5],
                    [0, 3],
                    [1, 4],
                    [2, 5],
                  ].map(([a, b]) => {
                    const pa = sp(points[a!]!);
                    const pb = sp(points[b!]!);
                    return <Line key={`${a}-${b}`} x1={pa[0]} y1={pa[1]} x2={pb[0]} y2={pb[1]} stroke={EDGE} strokeWidth={2.5} />;
                  })}
                  {points.map((p, i) => {
                    const [x, y] = sp(p);
                    const on = drag === i;
                    return <G key={i} x={x} y={y} label={LABELS[i]!} on={on} top={i >= 3} />;
                  })}
                </Svg>
              </View>
            ) : null}
            {dragged ? <Magnifier uri={photo.uri} point={dragged} imgSize={imgSize} scale={scale} left={sp(dragged)[0] > box.w / 2} /> : null}
          </>
        ) : null}
        {!photo && busy !== 'detect' ? (
          <View style={st.center}>
            <Icon name="card" size={32} color="#fff" />
            <Text style={st.centerTxt}>{t('reference.photographBoth')}</Text>
          </View>
        ) : null}
        {busy === 'detect' ? (
          <View style={[st.center, st.centerDim]}>
            <ActivityIndicator color="#fff" size="large" />
            <Text style={st.centerTxt}>{t('reference.searching')}</Text>
          </View>
        ) : null}
      </View>
      <Footer>
        {err ? <Banner kind="error" text={err} /> : null}
        {source === 'gallery' && photo ? <Banner kind="info" text={t('photos.galleryNote')} /> : null}
        {mustMove && !err ? <Banner kind="info" text={t('reference.moveHint')} /> : info && !err ? <Banner kind="info" text={info} /> : null}
        {result ? (
          <View style={st.res}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={st.resL}>{t('reference.found')}</Text>
              <Text style={st.resV} numberOfLines={1} adjustsFontSizeToFit>
                {fmtNum(Math.max(result.lengthCm, result.widthCm), 1)}×{fmtNum(Math.min(result.lengthCm, result.widthCm), 1)}×{fmtNum(result.heightCm, 1)}
                <Text style={st.resU}> cm</Text>
              </Text>
            </View>
            <Badge label={t('common.confidence', { n: Math.round(result.confidence * 100) })} kind={result.confidence >= 0.7 ? 'success' : 'warning'} />
          </View>
        ) : points.length === 6 ? (
          <View style={st.legend}>
            <View style={st.legendRow}>
              <View style={[st.legendDot, { borderColor: BOTTOM }]} />
              <Text style={st.help}>
                <Trans t={t} i18nKey="reference.legendBottom" components={{ b: <Text style={st.helpB} /> }} />
              </Text>
            </View>
            <View style={st.legendRow}>
              <View style={[st.legendDot, { borderColor: TOP }]} />
              <Text style={st.help}>
                <Trans t={t} i18nKey="reference.legendTop" components={{ b: <Text style={st.helpB} /> }} />
              </Text>
            </View>
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button label={t('reference.retake')} kind="secondary" icon="camera" onPress={() => setCamOpen(true)} style={{ flex: 1 }} disabled={busy !== null} large />
          {result ? (
            <Button label={t('reference.use')} icon="check" onPress={apply} style={{ flex: 1 }} large />
          ) : (
            <Button
              label={t('reference.measure')}
              icon="ruler"
              onPress={solve}
              loading={busy === 'solve'}
              disabled={!detect?.marker || points.length !== 6 || mustMove || busy === 'detect'}
              style={{ flex: 1 }}
              large
            />
          )}
        </View>
      </Footer>
      <PhotoCapture
        visible={camOpen}
        title={t('reference.captureTitle')}
        allowGallery
        hint={t('reference.captureHint')}
        onClose={() => {
          setCamOpen(false);
          if (!photo) router.back();
        }}
        onCapture={onCapture}
      />
    </View>
  );
}

/** Kamera üstü işaret renkleri: koyu fotoğraf üstünde okunur olsun diye açık tonlar. */
const BOTTOM = '#fdb022';
const TOP = '#84adff';
const EDGE = '#fdb022';
const MARKER = '#17b26a';

function G({ x, y, label, on, top }: { x: number; y: number; label: string; on: boolean; top: boolean }) {
  const fill = top ? TOP : BOTTOM;
  return (
    <>
      <Circle cx={x} cy={y} r={on ? 22 : 16} fill="rgba(0,0,0,0.3)" stroke={fill} strokeWidth={3} />
      <Circle cx={x} cy={y} r={3} fill="#fff" />
      <SvgText x={x + 20} y={y - 16} fill="#fff" fontSize={14} fontWeight="bold" stroke="#000" strokeWidth={0.6}>
        {label}
      </SvgText>
    </>
  );
}

function Magnifier({ uri, point, imgSize, scale, left }: { uri: string; point: Point; imgSize: { w: number; h: number }; scale: number; left: boolean }) {
  const k = scale * ZOOM;
  return (
    <View style={[st.mag, left ? { left: 12 } : { right: 12 }]} pointerEvents="none">
      <Image
        source={{ uri }}
        style={{ position: 'absolute', width: imgSize.w * k, height: imgSize.h * k, left: MAG / 2 - point[0] * k, top: MAG / 2 - point[1] * k }}
      />
      <View style={[st.cross, { width: 2, height: 28, left: MAG / 2 - 1, top: MAG / 2 - 14 }]} />
      <View style={[st.cross, { width: 28, height: 2, left: MAG / 2 - 14, top: MAG / 2 - 1 }]} />
    </View>
  );
}

const st = StyleSheet.create({
  stage: { flex: 1, backgroundColor: colors.camera, margin: 12, marginBottom: 10, borderRadius: radius.card, overflow: 'hidden' },
  center: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 16 },
  centerDim: { backgroundColor: 'rgba(10,26,58,0.55)' },
  centerTxt: { color: '#fff', fontSize: 14, lineHeight: 20, textAlign: 'center', ...font.medium },
  mag: { position: 'absolute', top: 8, width: MAG, height: MAG, borderRadius: MAG / 2, overflow: 'hidden', borderWidth: 3, borderColor: '#fff', backgroundColor: '#000' },
  cross: { position: 'absolute', backgroundColor: '#f04438' },
  res: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  resL: { fontSize: 12, lineHeight: 16, color: colors.text2, ...font.medium },
  resV: { fontSize: 24, lineHeight: 30, color: colors.text, ...font.semibold, fontVariant: ['tabular-nums'] },
  resU: { fontSize: 13, color: colors.text2, ...font.regular },
  legend: { gap: 4 },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  legendDot: { width: 12, height: 12, borderRadius: 6, borderWidth: 3, backgroundColor: colors.camera },
  help: { flex: 1, fontSize: 12, lineHeight: 17, color: colors.text2, ...font.regular },
  helpB: { color: colors.text, ...font.semibold },
});
