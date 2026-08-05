// A built-in city gazetteer so the app can resolve a birthplace to latitude,
// longitude and timezone offset entirely offline (no geocoding API needed).
// Users can always override with manual coordinates. Timezone offsets are the
// STANDARD (non-DST) offsets; a DST checkbox in the form handles summer time.

export interface City {
  name: string;
  admin: string; // state / region
  country: string;
  lat: number; // north positive
  lon: number; // east positive
  tz: number; // standard offset from UTC in hours (fallback if no IANA zone)
  zone?: string; // IANA zone; overrides the country default when the country spans zones
}

// Default IANA zone per country. Countries whose cities here span multiple zones
// (USA, Canada) carry an explicit `zone` on each city instead.
const COUNTRY_ZONE: Record<string, string> = {
  India: "Asia/Kolkata",
  Nepal: "Asia/Kathmandu",
  "Sri Lanka": "Asia/Colombo",
  Bangladesh: "Asia/Dhaka",
  Pakistan: "Asia/Karachi",
  Afghanistan: "Asia/Kabul",
  Bhutan: "Asia/Thimphu",
  "United Kingdom": "Europe/London",
  UAE: "Asia/Dubai",
  Qatar: "Asia/Qatar",
  "Saudi Arabia": "Asia/Riyadh",
  Singapore: "Asia/Singapore",
  Malaysia: "Asia/Kuala_Lumpur",
  Thailand: "Asia/Bangkok",
  China: "Asia/Shanghai",
  Japan: "Asia/Tokyo",
  "South Korea": "Asia/Seoul",
  "New Zealand": "Pacific/Auckland",
  France: "Europe/Paris",
  Germany: "Europe/Berlin",
  Switzerland: "Europe/Zurich",
  Netherlands: "Europe/Amsterdam",
  Italy: "Europe/Rome",
  Spain: "Europe/Madrid",
  Russia: "Europe/Moscow",
  Turkey: "Europe/Istanbul",
  Egypt: "Africa/Cairo",
  Kenya: "Africa/Nairobi",
  "South Africa": "Africa/Johannesburg",
  Nigeria: "Africa/Lagos",
  Brazil: "America/Sao_Paulo",
  Mexico: "America/Mexico_City",
  Argentina: "America/Argentina/Buenos_Aires",
  Australia: "Australia/Sydney",
};

/** IANA zone for a city, or null if none is known (fall back to the static tz). */
export function cityZone(c: City): string | null {
  return c.zone ?? COUNTRY_ZONE[c.country] ?? null;
}

export const CITIES: City[] = [
  // --- India (broad coverage) ---
  { name: "New Delhi", admin: "Delhi", country: "India", lat: 28.6139, lon: 77.209, tz: 5.5 },
  { name: "Mumbai", admin: "Maharashtra", country: "India", lat: 19.076, lon: 72.8777, tz: 5.5 },
  { name: "Kolkata", admin: "West Bengal", country: "India", lat: 22.5726, lon: 88.3639, tz: 5.5 },
  { name: "Chennai", admin: "Tamil Nadu", country: "India", lat: 13.0827, lon: 80.2707, tz: 5.5 },
  { name: "Bengaluru", admin: "Karnataka", country: "India", lat: 12.9716, lon: 77.5946, tz: 5.5 },
  { name: "Hyderabad", admin: "Telangana", country: "India", lat: 17.385, lon: 78.4867, tz: 5.5 },
  { name: "Pune", admin: "Maharashtra", country: "India", lat: 18.5204, lon: 73.8567, tz: 5.5 },
  { name: "Ahmedabad", admin: "Gujarat", country: "India", lat: 23.0225, lon: 72.5714, tz: 5.5 },
  { name: "Jaipur", admin: "Rajasthan", country: "India", lat: 26.9124, lon: 75.7873, tz: 5.5 },
  { name: "Lucknow", admin: "Uttar Pradesh", country: "India", lat: 26.8467, lon: 80.9462, tz: 5.5 },
  { name: "Kanpur", admin: "Uttar Pradesh", country: "India", lat: 26.4499, lon: 80.3319, tz: 5.5 },
  { name: "Nagpur", admin: "Maharashtra", country: "India", lat: 21.1458, lon: 79.0882, tz: 5.5 },
  { name: "Indore", admin: "Madhya Pradesh", country: "India", lat: 22.7196, lon: 75.8577, tz: 5.5 },
  { name: "Bhopal", admin: "Madhya Pradesh", country: "India", lat: 23.2599, lon: 77.4126, tz: 5.5 },
  { name: "Patna", admin: "Bihar", country: "India", lat: 25.5941, lon: 85.1376, tz: 5.5 },
  { name: "Varanasi", admin: "Uttar Pradesh", country: "India", lat: 25.3176, lon: 82.9739, tz: 5.5 },
  { name: "Surat", admin: "Gujarat", country: "India", lat: 21.1702, lon: 72.8311, tz: 5.5 },
  { name: "Chandigarh", admin: "Chandigarh", country: "India", lat: 30.7333, lon: 76.7794, tz: 5.5 },
  { name: "Amritsar", admin: "Punjab", country: "India", lat: 31.634, lon: 74.8723, tz: 5.5 },
  { name: "Kochi", admin: "Kerala", country: "India", lat: 9.9312, lon: 76.2673, tz: 5.5 },
  { name: "Thiruvananthapuram", admin: "Kerala", country: "India", lat: 8.5241, lon: 76.9366, tz: 5.5 },
  { name: "Coimbatore", admin: "Tamil Nadu", country: "India", lat: 11.0168, lon: 76.9558, tz: 5.5 },
  { name: "Visakhapatnam", admin: "Andhra Pradesh", country: "India", lat: 17.6868, lon: 83.2185, tz: 5.5 },
  { name: "Guwahati", admin: "Assam", country: "India", lat: 26.1445, lon: 91.7362, tz: 5.5 },
  { name: "Bhubaneswar", admin: "Odisha", country: "India", lat: 20.2961, lon: 85.8245, tz: 5.5 },
  { name: "Dehradun", admin: "Uttarakhand", country: "India", lat: 30.3165, lon: 78.0322, tz: 5.5 },
  { name: "Ranchi", admin: "Jharkhand", country: "India", lat: 23.3441, lon: 85.3096, tz: 5.5 },
  { name: "Raipur", admin: "Chhattisgarh", country: "India", lat: 21.2514, lon: 81.6296, tz: 5.5 },
  { name: "Ludhiana", admin: "Punjab", country: "India", lat: 30.901, lon: 75.8573, tz: 5.5 },
  { name: "Agra", admin: "Uttar Pradesh", country: "India", lat: 27.1767, lon: 78.0081, tz: 5.5 },
  { name: "Nashik", admin: "Maharashtra", country: "India", lat: 19.9975, lon: 73.7898, tz: 5.5 },
  { name: "Vijayawada", admin: "Andhra Pradesh", country: "India", lat: 16.5062, lon: 80.648, tz: 5.5 },
  { name: "Madurai", admin: "Tamil Nadu", country: "India", lat: 9.9252, lon: 78.1198, tz: 5.5 },
  { name: "Mysuru", admin: "Karnataka", country: "India", lat: 12.2958, lon: 76.6394, tz: 5.5 },
  { name: "Jodhpur", admin: "Rajasthan", country: "India", lat: 26.2389, lon: 73.0243, tz: 5.5 },
  { name: "Tirupati", admin: "Andhra Pradesh", country: "India", lat: 13.6288, lon: 79.4192, tz: 5.5 },
  { name: "Ujjain", admin: "Madhya Pradesh", country: "India", lat: 23.1765, lon: 75.7885, tz: 5.5 },
  { name: "Haridwar", admin: "Uttarakhand", country: "India", lat: 29.9457, lon: 78.1642, tz: 5.5 },
  { name: "Srinagar", admin: "Jammu & Kashmir", country: "India", lat: 34.0837, lon: 74.7973, tz: 5.5 },

  // --- South Asia neighbours ---
  { name: "Kathmandu", admin: "Bagmati", country: "Nepal", lat: 27.7172, lon: 85.324, tz: 5.75 },
  { name: "Colombo", admin: "Western", country: "Sri Lanka", lat: 6.9271, lon: 79.8612, tz: 5.5 },
  { name: "Dhaka", admin: "Dhaka", country: "Bangladesh", lat: 23.8103, lon: 90.4125, tz: 6 },
  { name: "Karachi", admin: "Sindh", country: "Pakistan", lat: 24.8607, lon: 67.0011, tz: 5 },
  { name: "Lahore", admin: "Punjab", country: "Pakistan", lat: 31.5204, lon: 74.3587, tz: 5 },
  { name: "Kabul", admin: "Kabul", country: "Afghanistan", lat: 34.5553, lon: 69.2075, tz: 4.5 },
  { name: "Thimphu", admin: "Thimphu", country: "Bhutan", lat: 27.4712, lon: 89.6339, tz: 6 },

  // --- Rest of the world (major hubs) ---
  { name: "London", admin: "England", country: "United Kingdom", lat: 51.5074, lon: -0.1278, tz: 0 },
  { name: "New York", admin: "New York", country: "United States", lat: 40.7128, lon: -74.006, tz: -5, zone: "America/New_York" },
  { name: "Los Angeles", admin: "California", country: "United States", lat: 34.0522, lon: -118.2437, tz: -8, zone: "America/Los_Angeles" },
  { name: "Chicago", admin: "Illinois", country: "United States", lat: 41.8781, lon: -87.6298, tz: -6, zone: "America/Chicago" },
  { name: "San Francisco", admin: "California", country: "United States", lat: 37.7749, lon: -122.4194, tz: -8, zone: "America/Los_Angeles" },
  { name: "Houston", admin: "Texas", country: "United States", lat: 29.7604, lon: -95.3698, tz: -6, zone: "America/Chicago" },
  { name: "Toronto", admin: "Ontario", country: "Canada", lat: 43.6532, lon: -79.3832, tz: -5, zone: "America/Toronto" },
  { name: "Vancouver", admin: "British Columbia", country: "Canada", lat: 49.2827, lon: -123.1207, tz: -8, zone: "America/Vancouver" },
  { name: "Dubai", admin: "Dubai", country: "UAE", lat: 25.2048, lon: 55.2708, tz: 4 },
  { name: "Abu Dhabi", admin: "Abu Dhabi", country: "UAE", lat: 24.4539, lon: 54.3773, tz: 4 },
  { name: "Doha", admin: "Doha", country: "Qatar", lat: 25.2854, lon: 51.531, tz: 3 },
  { name: "Riyadh", admin: "Riyadh", country: "Saudi Arabia", lat: 24.7136, lon: 46.6753, tz: 3 },
  { name: "Singapore", admin: "Singapore", country: "Singapore", lat: 1.3521, lon: 103.8198, tz: 8 },
  { name: "Kuala Lumpur", admin: "Kuala Lumpur", country: "Malaysia", lat: 3.139, lon: 101.6869, tz: 8 },
  { name: "Bangkok", admin: "Bangkok", country: "Thailand", lat: 13.7563, lon: 100.5018, tz: 7 },
  { name: "Hong Kong", admin: "Hong Kong", country: "China", lat: 22.3193, lon: 114.1694, tz: 8, zone: "Asia/Hong_Kong" },
  { name: "Beijing", admin: "Beijing", country: "China", lat: 39.9042, lon: 116.4074, tz: 8 },
  { name: "Shanghai", admin: "Shanghai", country: "China", lat: 31.2304, lon: 121.4737, tz: 8 },
  { name: "Tokyo", admin: "Tokyo", country: "Japan", lat: 35.6762, lon: 139.6503, tz: 9 },
  { name: "Seoul", admin: "Seoul", country: "South Korea", lat: 37.5665, lon: 126.978, tz: 9 },
  { name: "Sydney", admin: "New South Wales", country: "Australia", lat: -33.8688, lon: 151.2093, tz: 10 },
  { name: "Melbourne", admin: "Victoria", country: "Australia", lat: -37.8136, lon: 144.9631, tz: 10, zone: "Australia/Melbourne" },
  { name: "Auckland", admin: "Auckland", country: "New Zealand", lat: -36.8485, lon: 174.7633, tz: 12 },
  { name: "Paris", admin: "Île-de-France", country: "France", lat: 48.8566, lon: 2.3522, tz: 1 },
  { name: "Berlin", admin: "Berlin", country: "Germany", lat: 52.52, lon: 13.405, tz: 1 },
  { name: "Frankfurt", admin: "Hesse", country: "Germany", lat: 50.1109, lon: 8.6821, tz: 1 },
  { name: "Zurich", admin: "Zurich", country: "Switzerland", lat: 47.3769, lon: 8.5417, tz: 1 },
  { name: "Amsterdam", admin: "North Holland", country: "Netherlands", lat: 52.3676, lon: 4.9041, tz: 1 },
  { name: "Rome", admin: "Lazio", country: "Italy", lat: 41.9028, lon: 12.4964, tz: 1 },
  { name: "Madrid", admin: "Madrid", country: "Spain", lat: 40.4168, lon: -3.7038, tz: 1 },
  { name: "Moscow", admin: "Moscow", country: "Russia", lat: 55.7558, lon: 37.6173, tz: 3 },
  { name: "Istanbul", admin: "Istanbul", country: "Turkey", lat: 41.0082, lon: 28.9784, tz: 3 },
  { name: "Cairo", admin: "Cairo", country: "Egypt", lat: 30.0444, lon: 31.2357, tz: 2 },
  { name: "Nairobi", admin: "Nairobi", country: "Kenya", lat: -1.2921, lon: 36.8219, tz: 3 },
  { name: "Johannesburg", admin: "Gauteng", country: "South Africa", lat: -26.2041, lon: 28.0473, tz: 2 },
  { name: "Lagos", admin: "Lagos", country: "Nigeria", lat: 6.5244, lon: 3.3792, tz: 1 },
  { name: "São Paulo", admin: "São Paulo", country: "Brazil", lat: -23.5505, lon: -46.6333, tz: -3 },
  { name: "Mexico City", admin: "CDMX", country: "Mexico", lat: 19.4326, lon: -99.1332, tz: -6 },
  { name: "Buenos Aires", admin: "Buenos Aires", country: "Argentina", lat: -34.6037, lon: -58.3816, tz: -3 },
];

/** Case-insensitive prefix/substring search across name, admin and country. */
export function searchCities(query: string, limit = 8): City[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = CITIES.map((c) => {
    const name = c.name.toLowerCase();
    let score = -1;
    if (name === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (name.includes(q)) score = 2;
    else if (`${c.admin} ${c.country}`.toLowerCase().includes(q)) score = 3;
    return { c, score };
  }).filter((s) => s.score >= 0);
  scored.sort((a, b) => a.score - b.score || a.c.name.localeCompare(b.c.name));
  return scored.slice(0, limit).map((s) => s.c);
}
