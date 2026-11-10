/** app_settings key holding the preferred engine adapter ('mock' | 'live'). */
export const ENGINE_ADAPTER_SETTING = 'engine.adapter';

/** app_settings key for “允许 Studio 控制 HQPlayer” (boolean, default false). */
export const ENGINE_CONTROL_SETTING = 'engine.allowControl';
/** The user removed the demo library: never seed it again. */
export const DEMO_REMOVED_SETTING = 'library.demoRemoved';
/** Opt-in: ask MusicBrainz about album folders the local rules cannot settle. */
export const ONLINE_ALBUM_CHECK_SETTING = 'library.onlineAlbumCheck';
/** Settings → 歌词: ask online sources (boolean, default false — sends track names to a third party). */
export const LYRICS_ONLINE_SETTING = 'lyrics.online';
/** Settings → 歌词: which online sources may be asked (array of ids; unset = LRCLIB only). */
export const LYRICS_PROVIDERS_SETTING = 'lyrics.providers';
/** Settings → 音乐库 → 封面: look for missing covers online (boolean, default false). */
export const COVERS_ONLINE_SETTING = 'covers.online';
/** Settings → 音乐库 → 封面: which cover sources may be asked (array of ids; unset = all). */
export const COVERS_PROVIDERS_SETTING = 'covers.providers';
