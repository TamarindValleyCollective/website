// Reference points for the wildlife corridor chain described in prose on
// /about (Bannerghatta -> Cauvery North WLS/Melagiris -> MM Hills -> BR
// Hills -> Sathyamangalam -> Nilgiri Biosphere Reserve). Coordinates are
// each protected area's approximate centroid/label point, not a traced
// boundary -- good enough to show relative position and scale on a
// regional map, not a substitute for an official GIS boundary. Sourced
// from Wikipedia/NTCA reference points for each reserve (see CorridorMap
// usage for the citation-bearing caption). Labels reuse the exact kn/ta
// wording already used for these same places in AboutView.astro so the
// two pages don't drift into inconsistent translations of the same name.
export interface CorridorLandmark {
  id: string;
  lat: number;
  lng: number;
  label: Record<'en' | 'kn' | 'ta', string>;
}

export const CORRIDOR_LANDMARKS: CorridorLandmark[] = [
  {
    id: 'bannerghatta',
    lat: 12.7767,
    lng: 77.6105,
    label: { en: 'Bannerghatta National Park', kn: 'ಬನ್ನೇರುಘಟ್ಟ ರಾಷ್ಟ್ರೀಯ ಉದ್ಯಾನ', ta: 'பன்னேர்காட்டா தேசிய பூங்கா' },
  },
  {
    id: 'mm-hills',
    lat: 11.962,
    lng: 77.442,
    label: { en: 'MM Hills Wildlife Sanctuary', kn: 'MM ಬೆಟ್ಟಗಳ ವನ್ಯಜೀವಿ ಅಭಯಾರಣ್ಯ', ta: 'MM மலைகள் வனவிலங்கு சரணாலயம்' },
  },
  {
    id: 'brt',
    lat: 11.97,
    lng: 77.13,
    label: { en: 'BR Hills (BRT) Tiger Reserve', kn: 'BR ಬೆಟ್ಟಗಳ (BRT) ಹುಲಿ ಸಂರಕ್ಷಿತಾರಣ್ಯ', ta: 'BR மலைகள் (BRT) புலிகள் காப்பகம்' },
  },
  {
    id: 'sathyamangalam',
    lat: 11.64,
    lng: 77.226,
    label: { en: 'Sathyamangalam Tiger Reserve', kn: 'ಸತ್ಯಮಂಗಲಂ ಹುಲಿ ಸಂರಕ್ಷಿತಾರಣ್ಯ', ta: 'சத்தியமங்கலம் புலிகள் காப்பகம்' },
  },
  {
    id: 'nilgiri',
    lat: 11.55,
    lng: 76.625,
    label: { en: 'Nilgiri Biosphere Reserve', kn: 'ನೀಲಗಿರಿ ಜೀವಗೋಳ ಮೀಸಲು', ta: 'நீலகிரி உயிர்க்கோள இருப்பு' },
  },
];
