// Redirige UNIQUEMENT l'hôte de préproduction vers la simulation locale (port dans MOCK_PORT).
const real = globalThis.fetch;
globalThis.fetch = (u, o) => real(String(u).replace('https://njjaomichdlnoscrnxlz.supabase.co', `http://127.0.0.1:${process.env.MOCK_PORT}`), o);
