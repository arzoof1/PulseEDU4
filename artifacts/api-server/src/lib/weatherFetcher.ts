// Thin wrapper around Open-Meteo's free /v1/forecast endpoint with the
// `past_days` parameter, which gives us up to 92 days of daily history
// PLUS today's observed data without needing an API key. Returns an
// empty array on any error (timeout, non-200, malformed body) so the
// seeder can keep going if the network blip is transient.

const OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast";

export interface WeatherDayData {
  day: string; // YYYY-MM-DD in the requested timezone
  tempHighF: number | null;
  tempLowF: number | null;
  precipInches: number | null;
  weatherCode: number | null;
  summary: string | null;
}

// WMO weather-code groupings → short human label. Matches the buckets
// the dashboard uses to color days as "rain" vs "clear" vs "storm".
export function summarizeWeatherCode(code: number): string {
  if (code === 0) return "Clear";
  if (code <= 3) return "Cloudy";
  if (code <= 49) return "Fog";
  if (code <= 57) return "Drizzle";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Showers";
  if (code <= 86) return "Snow showers";
  if (code <= 99) return "Thunderstorm";
  return "Unknown";
}

export async function fetchWeatherForLocation(opts: {
  latitude: number;
  longitude: number;
  pastDays: number;
  timezone: string;
}): Promise<WeatherDayData[]> {
  const { latitude, longitude, pastDays, timezone } = opts;
  const url = new URL(OPEN_METEO_FORECAST);
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum",
  );
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("precipitation_unit", "inch");
  url.searchParams.set("past_days", String(Math.min(Math.max(pastDays, 1), 92)));
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("timezone", timezone);

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url.toString(), { signal: ctrl.signal });
    if (!r.ok) return [];
    const json = (await r.json()) as {
      daily?: {
        time?: string[];
        weather_code?: (number | null)[];
        temperature_2m_max?: (number | null)[];
        temperature_2m_min?: (number | null)[];
        precipitation_sum?: (number | null)[];
      };
    };
    const d = json.daily;
    if (!d?.time) return [];
    const out: WeatherDayData[] = [];
    for (let i = 0; i < d.time.length; i++) {
      const code = d.weather_code?.[i] ?? null;
      out.push({
        day: d.time[i],
        tempHighF: d.temperature_2m_max?.[i] ?? null,
        tempLowF: d.temperature_2m_min?.[i] ?? null,
        precipInches: d.precipitation_sum?.[i] ?? null,
        weatherCode: code,
        summary: code != null ? summarizeWeatherCode(code) : null,
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}
