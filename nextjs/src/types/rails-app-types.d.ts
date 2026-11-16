// Ambient declarations app/javascript is type-checked with in the Rails app (its tsconfig includes the
// whole directory). A converted page pulls the shared components in, and they rely on these. Not
// types/index.d.ts: it retypes Object.keys and String#split for the whole program.
/// <reference path="../../../app/javascript/types/activestorage.d.ts" />
/// <reference path="../../../app/javascript/types/evaporate.d.ts" />
/// <reference path="../../../app/javascript/types/analytics.d.ts" />
/// <reference path="../../../app/javascript/types/dropbox.d.ts" />
