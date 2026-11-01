/**
 * Minimal Roblox XML place (.rbxlx) used for sandbox places: a baseplate and a spawn location.
 * Studio fills in every service that is not listed, so the file stays tiny and readable.
 */
export function sandboxPlaceXml(title = 'Shuriken Sandbox'): string {
  const cf = (x: number, y: number, z: number) =>
    `<X>${x}</X><Y>${y}</Y><Z>${z}</Z><R00>1</R00><R01>0</R01><R02>0</R02><R10>0</R10><R11>1</R11><R12>0</R12><R20>0</R20><R21>0</R21><R22>1</R22>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">
  <Meta name="ExplicitAutoJoints">true</Meta>
  <Item class="Workspace" referent="RBX0">
    <Properties>
      <string name="Name">Workspace</string>
    </Properties>
    <Item class="Part" referent="RBX1">
      <Properties>
        <string name="Name">Baseplate</string>
        <bool name="Anchored">true</bool>
        <bool name="Locked">true</bool>
        <Color3uint8 name="Color3uint8">4284506208</Color3uint8>
        <token name="Material">256</token>
        <Vector3 name="size"><X>512</X><Y>16</Y><Z>512</Z></Vector3>
        <CoordinateFrame name="CFrame">${cf(0, -8, 0)}</CoordinateFrame>
      </Properties>
    </Item>
    <Item class="SpawnLocation" referent="RBX2">
      <Properties>
        <string name="Name">SpawnLocation</string>
        <bool name="Anchored">true</bool>
        <Vector3 name="size"><X>12</X><Y>1</Y><Z>12</Z></Vector3>
        <CoordinateFrame name="CFrame">${cf(0, 0.5, 0)}</CoordinateFrame>
        <float name="Duration">0</float>
      </Properties>
    </Item>
    <Item class="StringValue" referent="RBX3">
      <Properties>
        <string name="Name">ShurikenSandbox</string>
        <string name="Value">${title.replace(/[<&>]/g, '')}</string>
      </Properties>
    </Item>
  </Item>
</roblox>
`;
}
