/**
 * 時刻表精簡編碼
 *
 * TDX 原始 JSON 每個停靠站都帶四種語言的站名，但站名可以由 StationID 還原
 * （Worker 已有站牌對照表），不需要重複存。這裡把整日時刻表壓成純文字：
 *
 *   每班次一行：  <車次>|<車種碼>|<方向>|<停靠站>
 *   停靠站為定寬 12 字元一組：
 *
 *       1000 0728 0731
 *       └站ID └到站 └發車      時刻為 HHMM，去掉冒號；缺值寫 ----
 *
 * 台鐵與高鐵的站牌 ID 都是 4 位數字（實測 245 站全為 4 碼），所以不需要分隔符。
 *
 *   encodeDay()   排程端用：抓完 TDX 整日時刻表後轉檔，寫入 KV
 *   decodeTrain() Worker 用：還原成前端既有的 StopTimes 形狀
 *   bucketOf()    分桶：車次號 % 16，把寫入打散到 16 個 key
 */

const BUCKETS = 16;
const MISSING = '----';

const pad4  = v => String(v ?? '').padStart(4, '0').slice(-4);
const toHHMM = t => {
  const s = String(t ?? '').replace(/:/g, '');
  return s.length >= 4 ? s.slice(0, 4) : MISSING;   // "07:28" / "07:28:00" → "0728"
};
const toColon = s => (s === MISSING ? '' : `${s.slice(0, 2)}:${s.slice(2, 4)}`);

/**
 * 從整日時刻表抽出 StationID → 站名。
 *
 * 編碼時丟掉站名是為了省空間，解碼時再由對照表還原 —— 但 TDX 的 Station API
 * 只列現役車站，會落後時刻表（實測 1105 從 2026-10-03 起出現在時刻表，
 * Station API 當時仍查不到）。所以站名要以時刻表本身為準，不能只靠站牌表。
 */
export function collectStationNames(raw) {
  const list = Array.isArray(raw)
    ? raw
    : (raw?.TrainTimetables || raw?.DailyTimetables || []);

  const out = {};
  for (const tt of list) {
    for (const s of tt.StopTimes || []) {
      const name = (s.StationName?.Zh_tw || '').replace(/臺/g, '台');
      if (s.StationID && name) out[pad4(s.StationID)] = name;
    }
  }
  return out;
}

/** 車次號分桶。非數字車次退回字元碼加總，確保一定落在 0..15。 */
export function bucketOf(trainNo) {
  const n = parseInt(trainNo, 10);
  if (Number.isFinite(n)) return Math.abs(n) % BUCKETS;
  let h = 0;
  for (const c of String(trainNo)) h = (h + c.charCodeAt(0)) % BUCKETS;
  return h;
}

/**
 * 把 TDX 整日時刻表回應編成精簡字串。
 * 台鐵回 { TrainTimetables: [...] }，高鐵直接回陣列，兩種都吃。
 */
export function encodeDay(raw) {
  const list = Array.isArray(raw)
    ? raw
    : (raw?.TrainTimetables || raw?.DailyTimetables || []);

  const lines = [];
  for (const tt of list) {
    const info = tt.TrainInfo || tt.DailyTrainInfo || {};
    const no   = info.TrainNo;
    if (!no) continue;

    let stops = '';
    for (const s of tt.StopTimes || []) {
      stops += pad4(s.StationID) + toHHMM(s.ArrivalTime) + toHHMM(s.DepartureTime);
    }
    lines.push(`${no}|${info.TrainTypeCode ?? ''}|${info.Direction ?? ''}|${stops}`);
  }
  return lines.join('\n');
}

/** 同上，但直接分好 16 桶，回傳 { 0: '…', 1: '…', … } */
export function encodeDayBuckets(raw) {
  const buckets = {};
  for (const line of encodeDay(raw).split('\n')) {
    if (!line) continue;
    const b = bucketOf(line.slice(0, line.indexOf('|')));
    buckets[b] = buckets[b] ? `${buckets[b]}\n${line}` : line;
  }
  return buckets;
}

/**
 * 從精簡字串取出單一班次，還原成前端既有的形狀。
 * stationName: (stationId) => 中文站名，由呼叫端提供（Worker 的站牌對照表反轉）。
 */
export function decodeTrain(encoded, trainNo, stationName = () => '') {
  const prefix = `${trainNo}|`;
  for (const line of String(encoded).split('\n')) {
    if (!line.startsWith(prefix)) continue;

    const [no, typeCode, direction, stops = ''] = line.split('|');
    const StopTimes = [];
    for (let i = 0; i + 12 <= stops.length; i += 12) {
      const id = stops.slice(i, i + 4);
      StopTimes.push({
        StopSequence:  StopTimes.length + 1,
        StationID:     id,
        StationName:   { Zh_tw: stationName(id) || '' },
        ArrivalTime:   toColon(stops.slice(i + 4, i + 8)),
        DepartureTime: toColon(stops.slice(i + 8, i + 12)),
      });
    }
    return {
      TrainNo:       no,
      TrainTypeCode: typeCode,
      Direction:     direction === '' ? null : Number(direction),
      StopTimes,
    };
  }
  return null;
}
