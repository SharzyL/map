# Tools for the data scripts (OSM railways, official lines, relations, routing):
# nix-shell data_builder/shell.nix --run '...'
{ pkgs ? import <nixpkgs> { } }:
pkgs.mkShell {
  packages = [
    pkgs.osmium-tool
    (pkgs.python3.withPackages (ps: [ ps.osmium ps.numpy ps.scipy ps.shapely ps.markdown ps.pygments ]))
  ];
}
