# Tools for the data scripts (extract, lines, relations, routing):
# nix-shell scripts/routing/shell.nix --run '...'
{ pkgs ? import <nixpkgs> { } }:
pkgs.mkShell {
  packages = [
    pkgs.osmium-tool
    (pkgs.python3.withPackages (ps: [ ps.osmium ps.numpy ps.scipy ps.shapely ]))
  ];
}
