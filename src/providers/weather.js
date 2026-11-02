import { fetchJson, cached } from '../cache.js';
import { getConfig } from '../config.js';

// WMO weather code -> short Chinese description.
const WMO = {
  0: '晴', 1: '少云', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '小雨', 55: '中雨',
  56: '冻毛雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷雹', 99: '强雷雹'
};
const wmo = (c) => WMO[c] ?? `码${c}`;

export async function getWeather() {
  const { lat, lon, city } = getConfig().weather;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,weather_code,relative_humidity_2m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset` +
    `&timezone=auto&forecast_days=5`;

  return cached('weather', 10 * 60 * 1000, async () => {
    const r = await fetchJson(url);
    if (!r.ok) return { ok: false, error: r.error, city };
    const c = r.data.current || {};
    const d = (r.data.daily || {});
    return {
      ok: true,
      city,
      temp: c.temperature_2m,
      humidity: c.relative_humidity_2m,
      code: c.weather_code,
      text: wmo(c.weather_code),
      high: d.temperature_2m_max?.[0],
      low: d.temperature_2m_min?.[0],
      sunrise: d.sunrise?.[0],
      sunset: d.sunset?.[0],
      forecast: (d.time || []).slice(0, 5).map((date, i) => ({
        date,
        code: d.weather_code?.[i],
        text: wmo(d.weather_code?.[i]),
        high: d.temperature_2m_max?.[i],
        low: d.temperature_2m_min?.[i]
      })),
      source: 'open-meteo'
    };
  });
}
