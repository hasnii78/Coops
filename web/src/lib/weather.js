/**
 * Weather lookup for time- and season-aware suggestions.
 *
 * Location is deliberately coarse. Coordinates are rounded to 2 decimal places
 * (roughly a 1km cell) before they leave the device, and the rounded value is
 * all that is ever sent or stored. Precise GPS is never used, never cached and
 * never written to Firestore.
 */

const ENDPOINT = 'https://api.openweathermap.org/data/2.5/weather';
const API_KEY = import.meta.env.VITE_OPENWEATHER_API_KEY;

const COARSE_DECIMALS = 2;
const CACHE_MINUTES = 30;

function roundCoarse(value) {
  return Number(value.toFixed(COARSE_DECIMALS));
}

export function getApproximateLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Location is not available on this device.'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      ({ coords }) =>
        resolve({
          lat: roundCoarse(coords.latitude),
          lon: roundCoarse(coords.longitude),
        }),
      () => reject(new Error('Location permission was declined.')),
      // Low accuracy is a feature here, not a compromise: we only need the
      // city, and it drains far less battery.
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 30 * 60 * 1000 },
    );
  });
}

export async function fetchWeather({ lat, lon }) {
  if (!API_KEY) return null;

  const cacheKey = `pw-weather-${lat}-${lon}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;

  const url = `${ENDPOINT}?lat=${lat}&lon=${lon}&units=metric&appid=${API_KEY}`;
  const response = await fetch(url);

  if (!response.ok) return null;

  const body = await response.json();
  const result = {
    tempC: Math.round(body.main?.temp ?? 0),
    condition: body.weather?.[0]?.main ?? 'Clear',
    description: body.weather?.[0]?.description ?? '',
    city: body.name ?? '',
  };

  writeCache(cacheKey, result);
  return result;
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { value, at } = JSON.parse(raw);
    if (Date.now() - at > CACHE_MINUTES * 60 * 1000) return null;
    return value;
  } catch {
    return null;
  }
}

function writeCache(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify({ value, at: Date.now() }));
  } catch {
    // Storage can be unavailable in private mode; weather is optional.
  }
}

export function seasonFor(date = new Date()) {
  const month = date.getMonth();
  if (month <= 1 || month === 11) return 'winter';
  if (month <= 4) return 'spring';
  if (month <= 7) return 'summer';
  return 'autumn';
}
