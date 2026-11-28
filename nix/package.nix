{ lib
, stdenv
, pkg-config
, gtk4
, webkitgtk_6_0
, python3
, makeWrapper
}:

let
  scribe-locald = python3.pkgs.buildPythonApplication {
    pname = "scribe-locald";
    version = "0.2.0";
    pyproject = true;
    src = ../desktop/daemon;
    nativeBuildInputs = [ python3.pkgs.setuptools ];
    doCheck = false;
  };
in
stdenv.mkDerivation {
  pname = "scribe-desktop";
  version = "0.2.0";
  src = ../.;

  nativeBuildInputs = [ pkg-config makeWrapper ];
  buildInputs = [ gtk4 webkitgtk_6_0 ];

  buildPhase = ''
    make -C desktop/linux_shell
  '';

  installPhase = ''
    mkdir -p $out/bin $out/share/scribe/ui $out/share/applications $out/share/icons/hicolor/scalable/apps
    cp desktop/linux_shell/scribe $out/bin/scribe-shell
    cp -r desktop/ui/dist/* $out/share/scribe/ui/
    cp assets/scribe.desktop $out/share/applications/scribe.desktop
    cp assets/scribe.svg $out/share/icons/hicolor/scalable/apps/scribe.svg

    cat > $out/bin/scribe <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export SCRIBE_UI_DIST="@out@/share/scribe/ui"
export SCRIBE_PORT="''${SCRIBE_PORT:-47921}"
export SCRIBE_UI_URL="http://127.0.0.1:''${SCRIBE_PORT}/"
export WEBKIT_DISABLE_DMABUF_RENDERER="''${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"
if [ "''${1:-}" = "--self-test" ]; then
  "@out@/bin/scribe-shell" --self-test
  "@locald@/bin/scribe-locald" --self-test
  exit 0
fi
"@locald@/bin/scribe-locald" &
DAEMON_PID=$!
trap 'kill "$DAEMON_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do
  if (exec 3<>"/dev/tcp/127.0.0.1/''${SCRIBE_PORT}") 2>/dev/null; then
    exec 3>&-
    break
  fi
  sleep 0.1
done
exec "@out@/bin/scribe-shell" "$@"
EOF
    substituteInPlace $out/bin/scribe \
      --replace-fail "@out@" "$out" \
      --replace-fail "@locald@" "${scribe-locald}"
    chmod +x $out/bin/scribe
  '';

  passthru = {
    inherit scribe-locald;
  };

  meta = with lib; {
    description = "Scribe Desktop — Orb Hybrid Markdown, LaTeX, and Voice Notes";
    license = licenses.mit;
    platforms = platforms.linux;
    mainProgram = "scribe";
  };
}
