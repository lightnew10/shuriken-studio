import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The mark's turn must stay something the compositor can run by itself: a transform, and nothing else
// (see src/renderer/src/lib/working-mark.ts for what per-pixel animations cost).
describe('the working mark in the stylesheet and the component', () => {
  const src = join(__dirname, '..', 'src', 'renderer', 'src');
  const css = readFileSync(join(src, 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
  const logo = readFileSync(join(src, 'brand', 'logo.tsx'), 'utf8');

  it('turns with a transform only, a quarter turn at a time', () => {
    const frames = /@keyframes px-spin \{([\s\S]*?)\n\}/.exec(css)![1]!;
    expect(frames).toMatch(/rotate\(90deg\)/);
    expect(frames.replace(/transform:[^;]+;/g, '')).not.toMatch(/[a-z-]+\s*:/);
    expect(css).toMatch(/\.px-spin \{[^}]*animation: px-spin/);
  });

  it('gives the pixels their own animation only in the fall', () => {
    expect(logo).toMatch(/const motion = markMotion\(size, active, rich\)/);
    expect(logo).toMatch(/style=\{motion === 'fall' \? /);
    expect(logo).toMatch(/className=\{motion === 'fall' \? 'px-active' : motion === 'spin' \? 'px-spin' : undefined\}/);
  });
});
