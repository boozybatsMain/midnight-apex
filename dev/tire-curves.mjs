// prints magic formula characteristics for candidate tire params
const magic = (al, B, C, E) => { const x = B * al; return Math.sin(C * Math.atan(x - E * (x - Math.atan(x)))); };
const cands = process.argv.slice(2).map((s) => s.split(',').map(Number));
for (const [B, C, E, mu] of cands) {
  let best = 0, bestA = 0;
  for (let a = 0; a < 1.2; a += 0.0005) { const f = magic(a, B, C, E); if (f > best) { best = f; bestA = a; } }
  const pts = [1, 2, 3, 5, 8, 12, 20, 30, 45, 90].map((d) => `${d}°:${magic(d / 57.3, B, C, E).toFixed(2)}`).join(' ');
  console.log(`B${B} C${C} E${E} mu${mu}: peak@${(bestA * 57.3).toFixed(1)}° slope*mu ${(B * C * mu).toFixed(1)} | ${pts}`);
}
