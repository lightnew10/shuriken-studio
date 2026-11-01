import { useEffect, useState } from 'react';
import type { RigSpec } from '@shared/rig';
import { rpc } from '../../lib/rpc';
import type { ModelPart } from '../models/model-view';

/** A rigged model to play a custom rig's clips on: its rig and its parts (GLBs, looks, segments). */
export interface RigModel {
  spec: RigSpec;
  parts: ModelPart[];
}

export interface RigPartRow {
  name: string;
  color?: string;
  material?: string;
  origin?: [number, number, number];
  segment?: string;
}

/** Loads a rigged model's parts for the stage (null while loading, or for R15 clips). */
export function useRigModel(spec: RigSpec | null, parts: RigPartRow[] | undefined): RigModel | null {
  const [model, setModel] = useState<RigModel | null>(null);
  const key = spec ? `${spec.model}:${(parts ?? []).map((p) => p.name).join(',')}` : '';
  useEffect(() => {
    if (!spec || !parts?.length) {
      setModel(null);
      return;
    }
    let cancelled = false;
    void Promise.all(parts.map((p) => rpc<string>('models.glb', { name: p.name }).then((url): ModelPart => ({ url, color: p.color, material: p.material, origin: p.origin, segment: p.segment }))))
      .then((ps) => {
        if (!cancelled) setModel({ spec, parts: ps });
      })
      .catch(() => {
        if (!cancelled) setModel(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return model;
}

