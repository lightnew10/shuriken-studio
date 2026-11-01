/**
 * The agents' scratch folder: `<project>/.shuriken/scratch/`. Throwaway scripts and intermediate files go there
 * instead of the system Temp folder, which is outside the project and therefore refused (a Write to
 * `%TEMP%\seam.py` was, in an overnight build, and the agent had nowhere it knew it could use). It exists in
 * every open project (ProjectContext), is ignored by the project's git, and is inside the project, so the file
 * gate lets agents write there and the shell gate lets them delete there (`rm -rf .shuriken/scratch/tmp_tex`),
 * in both permission modes' terms: nothing in it is the app's own data.
 */
export const SCRATCH_DIR = 'scratch';

/** The scratch folder as agents are told it, relative to the project folder. */
export const SCRATCH_REL = `.shuriken/${SCRATCH_DIR}`;
