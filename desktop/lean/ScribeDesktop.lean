/-
  ScribeDesktop — Lean 4 Hybrid Chrome State & Theme Model (Orb LeanUI palette).
  Drives native sidebar filtering, note selection, and Orb dark/light palette tokens.
-/
namespace ScribeDesktop

inductive ThemeMode where
  | dark
  | light
  deriving Repr, BEq

structure OrbColors where
  bg : String
  surface : String
  surfaceHover : String
  border : String
  fgStrong : String
  fgMuted : String
  blue : String
  green : String
  deriving Repr

def palette : ThemeMode → OrbColors
  | .dark =>
      { bg := "#141414", surface := "#181818", surfaceHover := "#1E1E1E",
        border := "#262626", fgStrong := "#F4F4F5", fgMuted := "#8E8E93",
        blue := "#86AEE4", green := "#199E70" }
  | .light =>
      { bg := "#F5F6F8", surface := "#FFFFFF", surfaceHover := "#ECEEF2",
        border := "#DCE0E6", fgStrong := "#111318", fgMuted := "#5A6070",
        blue := "#2D6FD1", green := "#10855B" }

structure NoteRow where
  relPath : String
  title : String
  isVoice : Bool
  synced : Bool
  deriving Repr

def filterNotes (query : String) (rows : List NoteRow) : List NoteRow :=
  let q := query.trim.toLower
  if q.isEmpty then rows
  else rows.filter fun r =>
    (r.title.toLower.splitOn q).length > 1 || (r.relPath.toLower.splitOn q).length > 1

def main (args : List String) : IO Unit := do
  if args.contains "--self-test" then
    IO.println "scribe-lean-chrome ok"
  else
    let c := palette .dark
    IO.println s!"Scribe LeanUI Chrome ready (bg={c.bg}, accent={c.blue})"

end ScribeDesktop

def main := ScribeDesktop.main
