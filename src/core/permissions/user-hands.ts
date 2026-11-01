/**
 * What only the person at the PC can do: restart or update Roblox Studio, sign in, switch on a Studio setting.
 * In autonomous mode the director answers an agent's question for the user, and for these it can only guess: in
 * one build Studio 0.741 refused every synced script until it was restarted, two agents asked for the restart,
 * the director answered "restart Studio now" to one and "the user isn't available, carry on" to the other, the
 * user sat at the PC and saw neither, and the team wrote code Studio never got. A question that asks for the
 * user's hands is shown to the user (a "Needs you" card), and nobody waits for it.
 */

const STUDIO = String.raw`(?:roblox\s+)?studio`;
const HANDS = new RegExp(
  [
    // Restart, reopen, close or update Studio (either word order), or the PC or the app.
    String.raw`\b(?:restart|relaunch|re-?open|re-?start|close|quit|update|reinstall)(?:s|ed|ing)?\b[^.\n]{0,50}\b${STUDIO}\b`,
    String.raw`\b${STUDIO}\b[^.\n]{0,40}\b(?:needs?|must|has to|should)\b[^.\n]{0,30}\b(?:restart|relaunch|re-?open|clos|updat)`,
    String.raw`\b(?:restart|reboot)(?:s|ed|ing)?\b[^.\n]{0,30}\b(?:the\s+)?(?:pc|computer|machine|shuriken|kiln|blender)\b`,
    // Sign in, or grant something in a window of the user's.
    String.raw`\b(?:sign|log)(?:ged|ing)?\s+(?:back\s+)?in(?:to)?\b[^.\n]{0,40}\b(?:studio|roblox|account|kiln|claude)\b`,
    String.raw`\b(?:enable|turn on|switch on|allow|grant|tick|check)\b[^.\n]{0,70}\b(?:in\s+${STUDIO}(?:'s)?\s+settings|studio settings|game settings|beta features?|mcp (?:server|permission)s?|assistant (?:permission|setting)s?)\b`,
    String.raw`\b(?:plug in|connect|unlock)\b[^.\n]{0,30}\b(?:the\s+)?(?:screen|display|monitor|pc)\b`,
  ].join('|'),
  'i',
);

/** Does this question ask for something only the person at the PC can do? */
export function needsUserHands(text: string): boolean {
  return HANDS.test(text);
}

/**
 * A question about Studio's playtest turn (a lock, a held or busy Studio, a sync that hangs behind a playtest). On
 * 2026-10-06 four such questions were "decided without asking" as "release the lock" — which neither the agent nor
 * the director could do — while Studio stayed held for 90 minutes. The app enforces the turn itself now; the agent is
 * told how, and nothing is decided.
 */
const STUDIO_TURN = /\b(?:playtest (?:lock|turn|lease)|(?:sync|studio) lock|lease|holds? (?:the )?studio|studio (?:is |was )?(?:held|busy|occupied|locked)|held by (?:another|a stuck)|stuck playtest|sync (?:is |keeps )?(?:blocked|hang(?:s|ing)?|stuck|timing out|times out)|release the (?:lock|hold))\b/i;
export function aboutStudioTurn(text: string): boolean {
  return STUDIO_TURN.test(text);
}

export const STUDIO_TURN_ANSWER =
  "Nobody needs to decide this: Shuriken keeps Studio's turns itself. A playtest plays at most 60 s once it is up and is then stopped, one Studio doesn't answer gives way after 90 s, a Studio that crashes takes its playtest with it, and the user can free Studio from the Agents page. Wait in line for your turn (your Studio calls wait by themselves), or go on with work that doesn't need Studio and come back to it.";

/** What the agent is told: the request is in front of the user, and the work goes on. */
export const HANDS_ANSWER =
  "Shown to the user: only they can do this (it is on their screen as \"Needs you\"). Nobody waits for it. Go on with everything that doesn't depend on it, keep your work on disk, and try again later in this task (the thing you need may be back within minutes); if it still isn't, finish what you can and say exactly what is left to do once it is.";
