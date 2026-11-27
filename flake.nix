{
  description = "Scribe — Markdown, LaTeX, and Voice Notes (Desktop + Android) with Hindsight sync";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-linux" "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          scribe-desktop = pkgs.callPackage ./nix/package.nix { };
        in
        {
          inherit scribe-desktop;
          scribe = scribe-desktop;
          scribe-locald = scribe-desktop.passthru.scribe-locald;
          default = scribe-desktop;
        }
      );

      overlays.default = final: _prev: {
        scribe-desktop = self.packages.${final.stdenv.hostPlatform.system}.scribe-desktop;
        scribe = final.scribe-desktop;
        scribe-locald = final.scribe-desktop.passthru.scribe-locald;
      };

      homeManagerModules.default = import ./nix/hm-module.nix;
    };
}
