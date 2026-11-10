/** app_settings key holding the preferred engine adapter ('mock' | 'live'). */
export const ENGINE_ADAPTER_SETTING = 'engine.adapter';

/** app_settings key for “允许 Studio 控制 HQPlayer” (boolean, default false). */
export const ENGINE_CONTROL_SETTING = 'engine.allowControl';
/** The user removed the demo library: never seed it again. */
export const DEMO_REMOVED_SETTING = 'library.demoRemoved';
/** Opt-in: ask MusicBrainz about album folders the local rules cannot settle. */
export const ONLINE_ALBUM_CHECK_SETTING = 'library.onlineAlbumCheck';
/** Settings → 歌词: ask LRCLIB online (boolean, default false — sends track names to a third party). */
export const LYRICS_ONLINE_SETTING = 'lyrics.online';
