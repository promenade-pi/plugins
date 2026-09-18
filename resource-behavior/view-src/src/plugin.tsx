import { bootView } from './bootstrap';
import { ProfilesView } from './ProfilesView';

/**
 * Entry point for the profile table. Its sibling `timeline.tsx` shows the same
 * artifact as a who-was-busy-when heatmap — two panels rather than tabs inside
 * one, so each keeps its own place in the tree's Views list and its own params.
 */
bootView((payload) => <ProfilesView payload={payload} />);
