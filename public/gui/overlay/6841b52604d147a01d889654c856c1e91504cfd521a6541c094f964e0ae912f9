// Added for the browser-tab computer (docs/GUI_SCORE.md): content processes get the
// font list by message, not shared memory. A shared file mapped by a second process
// doesn't see the first one's writes in the x86 engine yet, so content processes found
// no fonts and stopped (MOZ_RELEASE_ASSERT(mFontFamilies.Count() > 0)).
pref("gfx.e10s.font-list.shared", false);
