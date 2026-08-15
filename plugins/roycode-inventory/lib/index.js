// roycode-inventory host half: no host-side behavior; the browser half
// ships via exports["./client"], discovered through the package.json dshClient
// declaration. The empty apply makes the plugin visible to the Loader so it
// can be toggled from manage.ps1 / cordis.patch.yml.
function apply() {}
export { apply }
