import Lake
open Lake DSL

package «scribe-desktop» where
  version := v!"0.2.0"

@[default_target]
lean_lib «ScribeDesktop» where
  srcDir := "."

lean_exe «scribe-lean-chrome» where
  root := `ScribeDesktop
