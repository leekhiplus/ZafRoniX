/**
 * Every tunable limit lives here, in one place.
 */
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export const CONFIG = {
  video: {
    extensions: ['.mp4', '.m4v', '.mov', '.webm', '.mkv'],
    mimeTypes: ['video/mp4', 'video/x-m4v', 'video/quicktime', 'video/webm', 'video/x-matroska'],
    maxFileBytes: 1.5 * GiB,
    maxDurationSec: 30 * 60,
    /** The finished file is held in memory until you download it. */
    maxOutputBytes: 1.5 * GiB,
    /** Lower ceiling for phones and low-memory devices. */
    maxOutputBytesLowMemory: 400 * MiB,
    /** Frame rate assumed for the size estimate shown before processing (the real one is read later). */
    assumedFps: 30,
  },
  image: {
    extensions: ['.png', '.jpg', '.jpeg', '.webp'],
    mimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
    maxFileBytes: 100 * MiB,
  },
} as const;

export const STORAGE_KEY = 'zafronix.settings.v1';
