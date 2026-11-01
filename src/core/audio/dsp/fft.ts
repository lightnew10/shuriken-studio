/** A small radix-2 FFT for measurements and tests (aliasing, spectra, band balance). Not used in the render path. */

/** In-place iterative FFT; the length must be a power of two. `inverse` includes the 1/n scaling. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n & (n - 1)) throw new Error('fft length must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse)
    for (let i = 0; i < n; i++) {
      re[i]! /= n;
      im[i]! /= n;
    }
}

export const nextPow2 = (n: number): number => {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
};

/**
 * Band-limited (spectral zero-padding) upsampling by `factor`, exact for periodic or fully decayed
 * signals: an independent way to find inter-sample peaks. The input is zero-padded to a power of two.
 */
export function upsampleFft(x: ArrayLike<number>, factor: number): Float64Array {
  const n = nextPow2(x.length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < x.length; i++) re[i] = x[i]!;
  fft(re, im);
  const m = n * factor;
  const R = new Float64Array(m);
  const I = new Float64Array(m);
  const half = n >> 1;
  for (let k = 0; k <= half; k++) {
    R[k] = re[k]!;
    I[k] = im[k]!;
  }
  for (let k = 1; k < half; k++) {
    R[m - k] = re[n - k]!;
    I[m - k] = im[n - k]!;
  }
  fft(R, I, true);
  for (let i = 0; i < m; i++) R[i]! *= factor;
  return R;
}

/** Power spectrum |X[k]|^2 (k = 0..n/2) of a Hann-windowed segment. */
export function powerSpectrum(x: ArrayLike<number>, start: number, n: number): Float64Array {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = (x[start + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  fft(re, im);
  const out = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) out[k] = re[k]! * re[k]! + im[k]! * im[k]!;
  return out;
}
