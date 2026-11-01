/**
 * The Forge on the GPU (WebGL2): the CPU engine's pictures (src/core/ui/forge/) from forge plans, 15 to 70 times
 * faster. The core plans (@shared/forge-plan planForge: layout and contours, which need its fonts and glyphs), a page
 * draws (createForgeGL, or forgeRequest on the hidden render page); see forge-gl.ts.
 */

export { createForgeGL, distanceReach, type ForgeGL, type ForgeGLOptions } from './forge-gl';
export { forgedImageData, forgeGLUnavailable, forgeRequest, installForgePage, sharedForgeGL } from './forge-page';
export { forgeSkins, useForgePlans, type ForgedSkin, type ForgePlansState } from './use-forge-plans';
export { MAX_IMAGE, packContours, planForge, planFromWire, planToWire, scaleStyle, styleMargin, type Cut, type ForgeGLItem, type ForgeGLRequest, type ForgeGLResponse, type ForgePlan, type ForgePlansParams, type ForgePlansResult, type PlanLayer, type WirePlan } from '@shared/forge-plan';
export type * from '@shared/forge-types';
