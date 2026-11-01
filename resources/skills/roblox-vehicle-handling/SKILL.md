---
name: roblox-vehicle-handling
description: "Cars, karts, drift cars, racers, bikes and boats in Roblox that feel right from the first second: units and gravity (1 stud = 0.28 m, 5.6x real g), a raycast-suspension chassis with a friction-circle tyre model, launch control, steering sized by grip, rear-biased balance, assists that blend with the player, limited-slip drive, drift entry/hold/exit and scoring, keyboard/gamepad/touch input, chase camera, smoke and engine feedback, network ownership with server checks, and the acceptance checks (0-100 km/h, hands-off straight, symmetry, no limit cycle, tap vs hold, held drift, reset, a lap) an engineer runs and a critic re-runs in a playtest. Read before building or tuning any vehicle."
version: 1
tags: [vehicle, car, kart, racing, race, drift, drifting, handling, tyre, steering, suspension, raycast, chassis, drivetrain, differential, boat, bike, motorcycle, lap, track, speed, gravity, vehicleseat, networkownership, camera]
roblox_systems: [VehicleSeat, SpringConstraint, HingeConstraint, CylindricalConstraint, WorldRoot, RaycastParams, RunService, BasePart, Workspace, UserInputService, Camera]
version_applicability: "Roblox Studio 0.740+ (Sept 2026)"
required_tools: [luau_check, roblox_sync_push, roblox_run_luau, roblox_playtest, roblox_screenshot]
---
# Vehicle handling: launch, steering, balance, drift
## Purpose
Handling is judged in the first ten seconds: pulling away, a tap on the wheel, holding a corner, lifting off. A first full build (a drift game) had no
vehicle skill and the engineer spent four tasks (~$64) rediscovering the basics; the user: "from a stop the car just peels out and it takes ages… it
feels like the game is pushing you into drifting one way or another without the proper feel and amount of modulation". Every cause below was measured
there and has a fix and an acceptance check. Bikes and boats take the same ideas (a boat is a car whose tyre force is a keel: lateral drag, buoyancy
instead of springs); this skill's numbers are for four-wheelers.
## Pick the architecture
| Approach | Pick it for | Price |
|---|---|---|
| Raycast chassis: one assembly, one simple collision box, a ray per wheel, suspension + tyre forces from a model you own (below) | arcade, drift, racing, karts: feel is the product | you write the physics; every number is tunable |
| Constraints: SpringConstraint + HingeConstraint motor wheels (CylindricalConstraint struts) | player-built cars, trucks, crawlers, damage that must look physical | grip is Roblox friction: no tyre curve, launch and drift balance can't be tuned, only worked around |
| VehicleSeat alone (Throttle/SteerFloat, MaxSpeed, Torque, TurnSpeed read by hinge wheels) | prototypes, boats, props | goes straight and turns: no modulation, no drift |
- Simulate on the driver's client (`SetNetworkOwner(driver)`: no input lag). Set it yourself on `Seat.Occupant` changes: automatic ownership gives the physics to
the first passenger to sit or to whoever is nearest, and `SetNetworkOwner(nil)` makes a server-owned car rubber-band. The client can lie (teleport, speed): the
server stamps `OwnerId`, caps speed (~1.3x the top speed) and per-frame travel, puts a cheating car back at its last upright position and handles resets (RemoteEvent,
validated occupant, cooldown, bump `Epoch`; the chassis below reads both attributes). Anchored parts are always server-owned.
- One assembly: the chassis box is the only part with mass; wheels, body meshes and the driver's seat are Massless, CanCollide off, CanQuery off (rays must not hit your
own wheels). Visual meshes as collision cost a bulge in the hull and bumps (drive on the simple box); the character goes in a collision group that ignores the car.
## Units and gravity
- 1 stud = 0.28 m: 1 stud/s = 1.008 km/h (read studs/s as km/h; 100 km/h = 99 studs/s), 1 m = 3.6 studs, a real g = 35 studs/s², a car is ~14 studs long.
- Roblox gravity is 196.2 studs/s² = 5.6 real g. Grip (mu·g), the pull down a slope and spring sag all scale with it. Measured: on a 2.8° grade it pulls back
9.6 studs/s² (0.27 real g) against a launch of ~20: "launches took ages"; and mu 1 at 196 corners 100 km/h in a 50-stud circle: twitchy.
- Pick a vehicle gravity g_v and say which policy you use: (1) a compensating force `(workspace.Gravity - g_v)·mass` up on the chassis (below; characters keep
their jump), (2) `workspace.Gravity = g_v` when the whole game is driving, (3) plus a slope assist cancelling ~80% of the along-surface part of g_v (arcade; 0 for sim)
and downforce `k·v²`. Choose g_v from the map: `g_v = v²/(mu·R)` for the design speed v (studs/s) and a typical fast corner radius R (studs): 90 through 100 -> ~80.
Range 40 (sim, near real scale) to 100. Then tune in g_v units, never in raw studs: drive in 1st gear 0.4-0.7 g_v, corner radius `v²/(mu·g_v)`, slope pull `g_v·sin θ`.
## Reference implementation
`Vehicle` is the model as pure math (testable headless: it ran in Studio's Luau at 60 and 30 fps; numbers under Acceptance); `Chassis` is the glue. Per wheel:
spring and damper along the chassis' up, an anti-roll bar per axle; tyre forces from `Vehicle.step` applied at the wheel's x/z on the CG's plane (so weight
transfer comes from the model, once, not also from the springs). `ApplyImpulse*` takes force·dt, once per frame (`PreSimulation` runs on the 60 Hz job; there is no
hook in the 240 Hz sub-steps), with dt clamped to 1/30. Tyre: friction circle (`sqrt(1-(Fx/cap)²)` of the lateral grip is left), `sin(C·atan(B·slip))` curve with a plateau.
```lua
--!strict
-- src/Shared/Vehicle.luau: the handling model as pure math (no Instances): the chassis, a headless sim and the checks
-- call the same code. Studs, seconds, mass units; forces are mass x studs/s^2; yaw is positive to the left.
local Vehicle = {}
local arcade = { -- power: 1st-gear drive in units of gravity; tops: speed at redline per gear (studs/s)
	wheelbase = 9.6, track = 5.4, frontShare = 0.5, gravity = 80, muFront = 1.0, muRear = 1.06, peakSlip = 0.14, falloff = 1.3,
	power = 0.4, tops = { 67, 102, 138, 178, 217, 260 }, redline = 7000, drag = 0.00012, brake = 100,
	launchLimit = 0.92, diffBias = 3, downforce = 0.00002, transfer = 0.12, maxLock = 0.6, driftLock = 0.8, slideLock = 0.5,
	maxAngle = 0.9, angleGrip = 1.2, driftLoss = 0.15, assist = 0.8, yawDamp = 0.5, keyRate = 2.4, keyReturn = 4, throttleRate = 2.5,
}
export type Config = typeof(arcade)
export type Input = { throttle: number, brake: number, steer: number, handbrake: boolean, digital: boolean }
export type State = { steerIn: number, throttle: number, gear: number, rpm: number, af: number, ar: number, hb: number }
export type Force = { f: number, r: number, ff: number, fr: number, slide: number, util: number } -- FL FR RL RR, then drag
Vehicle.arcade = arcade
function Vehicle.newState(): State
	return { steerIn = 0, throttle = 0, gear = 1, rpm = 1000, af = 0, ar = 0, hb = 1 }
end
local function smooth(a: number, b: number, x: number): number
	local t = math.clamp((x - a) / (b - a), 0, 1)
	return t * t * (3 - 2 * t)
end
-- Tyre curve: 0 -> 1 at peakSlip, then a smooth fall-off to a plateau of sin(falloff * pi / 2) (0.85 at 1.35).
local function grip(cfg: Config, slip: number): number
	return math.sin(cfg.falloff * math.atan(math.tan(math.pi / (2 * cfg.falloff)) / cfg.peakSlip * slip))
end
-- A differential: bias 1 = open (the weaker wheel decides for both), 3 = limited slip, huge = locked. Returns (A, B).
local function split(total: number, capA: number, capB: number, bias: number): (number, number)
	local weak = math.min(total / 2, capA, capB)
	local strong = math.min(total - weak, bias * weak, math.max(capA, capB))
	return if capA <= capB then weak else strong, if capA <= capB then strong else weak
end

-- One step. vf forward, vr right, w yaw rate (ground plane). Returns the forces to apply, in the car frame.
function Vehicle.step(cfg: Config, st: State, input: Input, vf: number, vr: number, w: number, mass: number, dt: number): ({ Force }, number)
	local L, T = cfg.wheelbase, cfg.track
	local fa, ra = L * (1 - cfg.frontShare), L * cfg.frontShare -- CG to the front and rear axle
	local speed = math.sqrt(vf * vf + vr * vr)
	local beta = math.atan2(vr, math.abs(vf) + 0.5) -- slide angle, right +
	local slide = math.abs(beta)
	-- Steering: a held key is rate-limited, analog passes. Lock sized by grip, atan(L*mu*g/v^2); extra room only to
	-- counter-steer. The assist ADDS the angle that points the front tyres along their travel, from 10 deg of slide.
	if input.digital then
		local rate = if math.abs(input.steer) > math.abs(st.steerIn) then cfg.keyRate else cfg.keyReturn
		st.steerIn += math.clamp(input.steer - st.steerIn, -rate * dt, rate * dt)
	else
		st.steerIn = input.steer
	end
	local lock = math.clamp(math.atan(L * cfg.muFront * cfg.gravity / (speed * speed + 1)), 0.04, cfg.maxLock)
	if st.steerIn * beta > 0 then
		lock = math.min(lock + cfg.slideLock * slide, cfg.driftLock)
	end
	local front = math.atan2(vr - w * fa, math.abs(vf) + 1) -- where the front axle is really going
	local assist = cfg.assist * smooth(0.17, 0.45, math.abs(front)) * smooth(8, 25, vf)
	local delta = math.clamp(st.steerIn * lock + assist * front, -cfg.driftLock, cfg.driftLock)
	-- Pedals: a held key ramps the throttle (tapping modulates). A 1 stud/s band: creeping at -1e-7 studs/s is
	-- "stopped", never "rolling backwards" (a hard zero test once cancelled the drive force).
	local th, brk = input.throttle, input.brake
	if input.digital then
		st.throttle += math.clamp(th - st.throttle, -6 * dt, cfg.throttleRate * dt)
		th = st.throttle
	end
	local pedal, dir = th, 1
	if th < 0.05 and brk > 0.05 and vf < 1 then
		pedal, dir, brk = brk, -1, 0 -- stopped or rolling back: the brake pedal reverses
	elseif vf < -1 and th > 0.05 then
		pedal, brk = 0, math.max(brk, th) -- rolling back under throttle: brake first
	end
	-- Engine: rpm from ground speed; the clutch slips the engine up to its torque from a stop.
	local top = if dir < 0 then cfg.tops[1] else cfg.tops[st.gear] or 1
	local rpm = math.max(1000, cfg.redline * math.abs(vf) / top)
	if dir > 0 and rpm > cfg.redline * 0.92 and st.gear < #cfg.tops then
		st.gear += 1
	elseif dir > 0 and rpm < cfg.redline * 0.42 and st.gear > 1 then
		st.gear -= 1
	end
	local x = math.max(rpm / cfg.redline, 0.5 * pedal)
	st.rpm = x * cfg.redline
	local torque = if x >= 1 then 0 else math.max(0.3, 1 - 2.2 * (x - 0.62) ^ 2)
	local drive = dir * pedal * mass * cfg.gravity * cfg.power * (cfg.tops[1] / top) * torque * (if dir < 0 then 0.6 else 1)
	-- Tyre loads n = FL FR RL RR: static + longitudinal transfer (transfer = h/L) + HALF the lateral transfer (all
	-- of it feeds limit cycles) + downforce.
	local weight = mass * (cfg.gravity + cfg.downforce * speed * speed)
	local tl = cfg.transfer * mass * st.af -- accelerating moves load to the rear
	local tt = 0.5 * cfg.transfer * (L / T) * mass * st.ar -- being pushed right loads the left wheels
	local fAxle, rAxle = weight * cfg.frontShare - tl, weight * (1 - cfg.frontShare) + tl
	local n = { fAxle / 2 + tt / 2, fAxle / 2 - tt / 2, rAxle / 2 + tt / 2, rAxle / 2 - tt / 2 }
	local nSum = 0
	for i = 1, 4 do
		n[i] = math.max(n[i], 0.025 * weight)
		nSum += n[i]
	end
	-- Rear grip. Handbrake: gone fast, back slowly. In a slide it is smooth in angle and pedal (no switch to chatter):
	-- from ~10 deg the pedal costs grip so the angle follows the throttle; towards maxAngle grip returns (no spin).
	st.hb += math.clamp((if input.handbrake then 0.55 else 1) - st.hb, -dt * 8, dt * 2)
	local rear = cfg.muRear * st.hb * (1 + cfg.angleGrip * smooth(0.17, cfg.maxAngle, slide))
	rear *= 1 - cfg.driftLoss * smooth(0.1, 0.3, slide) * smooth(15, 40, speed) * pedal
	local mu = { cfg.muFront, cfg.muFront, rear, rear }
	-- Rear drive through the differential; no wheel asks for more than launchLimit x its grip (launch control).
	local l, r = split(math.abs(drive), cfg.launchLimit * mu[3] * n[3], cfg.launchLimit * mu[4] * n[4], cfg.diffBias)
	local fxDrive = { 0, 0, math.sign(drive) * l, math.sign(drive) * r }

	local out: { Force } = {}
	local sumF, sumR = 0, 0
	local stop = mass * 0.2 -- the most a wheel may brake or hold sideways in one step: never reverse its slip
	for i = 1, 4 do
		local isFront = i <= 2
		local pf, pr = if isFront then fa else -ra, if i % 2 == 0 then T / 2 else -T / 2
		local c, s = if isFront then math.cos(delta) else 1, if isFront then math.sin(delta) else 0
		local cf, cr = vf + w * pr, vr - w * pf -- contact patch velocity, car frame
		local wf, wr = cf * c + cr * s, -cf * s + cr * c -- and in the wheel's frame
		local cap = mu[i] * n[i]
		local brake = brk * cfg.brake * mass * n[i] / nSum
		if input.handbrake and not isFront then
			brake = math.max(brake, 0.35 * cap)
		end
		brake = math.min(brake, stop * math.abs(wf) / dt)
		local lim = if brake == 0 and fxDrive[i] ~= 0 then cap * cfg.launchLimit else cap
		local fx = math.clamp(fxDrive[i] - math.sign(wf) * brake, -lim, lim)
		local alpha = math.atan2(math.abs(wr), math.abs(wf) + 1.5) -- the speed floor keeps a standing car still
		local fy = -math.sign(wr) * cap * grip(cfg, alpha) * math.sqrt(math.max(0, 1 - (fx / cap) ^ 2)) -- friction circle
		fy = math.sign(fy) * math.min(math.abs(fy), stop * math.abs(wr) / dt)
		local ff, fr = fx * c - fy * s, fx * s + fy * c
		sumF += ff
		sumR += fr
		out[i] = { f = pf, r = pr, ff = ff, fr = fr, slide = math.abs(wr), util = math.sqrt(fx * fx + fy * fy) / cap }
	end
	local df = -mass * (cfg.drag * speed * vf + 1.5 * math.clamp(vf / 2, -1, 1)) -- air drag + rolling resistance
	local dr = -mass * cfg.drag * speed * vr
	out[5] = { f = 0, r = 0, ff = df, fr = dr, slide = 0, util = 0 }
	local k = 1 - math.exp(-dt / 0.1) -- the transfer follows the acceleration with a lag: no instant feedback
	st.af += ((sumF + df) / mass - st.af) * k
	st.ar += ((sumR + dr) / mass - st.ar) * k
	return out, delta
end

return Vehicle
```
```lua
--!strict
-- src/Client/Chassis.client.luau: raycast suspension + the Vehicle model for the car the local player drives.
-- Contract: a Model, PrimaryPart "Chassis" = the one simple collision box with mass (everything else Massless, CanCollide
-- and CanQuery off), Attachments WheelFL/FR/RL/RR on it (the suspension tops), a VehicleSeat "Seat" welded to it. The server
-- sets the attributes OwnerId (the driver's UserId) and Epoch (+1 on a reset).
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")
local Vehicle = require(ReplicatedStorage.Shared.Vehicle)

local cfg = table.clone(Vehicle.arcade)
local REST, TRAVEL, RADIUS, SLOPE = 1.2, 1.4, 1.6, 0.8 -- spring length at rest, extra travel, wheel radius, slope assist
local player, probe = Players.LocalPlayer, RaycastParams.new()
local car: Model?, st, epoch = nil, Vehicle.newState(), 0
local mounts: { Attachment } = {}
local springK, springC, mass, inertia = 0, 0, 0, 0

local function setup(model: Model)
	local root = model.PrimaryPart :: BasePart
	car, st, probe.FilterDescendantsInstances = model, Vehicle.newState(), { model }
	mounts = {}
	for _, name in { "WheelFL", "WheelFR", "WheelRL", "WheelRR" } do
		table.insert(mounts, root:FindFirstChild(name) :: Attachment)
	end
	local fl, fr, rl = root.CFrame:PointToObjectSpace(mounts[1].WorldPosition), root.CFrame:PointToObjectSpace(mounts[2].WorldPosition), root.CFrame:PointToObjectSpace(mounts[3].WorldPosition)
	mass, cfg.wheelbase, cfg.track = root.AssemblyMass, rl.Z - fl.Z, math.abs(fl.X - fr.X)
	cfg.frontShare = (rl.Z - root.CFrame:PointToObjectSpace(root.AssemblyCenterOfMass).Z) / cfg.wheelbase -- CG forward: front axle heavier
	inertia = mass * (root.Size.X ^ 2 + root.Size.Z ^ 2) / 12 -- Roblox's own inertia of a box
	springK = mass * cfg.gravity / 4 / TRAVEL -- static compression = TRAVEL at 1/4 of the weight
	springC = 2 * 0.7 * math.sqrt(springK * mass / 4)
end

RunService.PreSimulation:Connect(function(dt0)
	local humanoid = player.Character and player.Character:FindFirstChildOfClass("Humanoid")
	local seat = humanoid and humanoid.SeatPart
	local model = seat and seat.Parent
	if not (seat and seat:IsA("VehicleSeat") and model and model:IsA("Model")) then
		car = nil
		return
	end
	local stamp = (model:GetAttribute("Epoch") or 0) :: number
	if model ~= car or stamp ~= epoch then -- first frame in this car, or the server reset it
		epoch = stamp
		setup(model)
	end
	if model:GetAttribute("OwnerId") ~= player.UserId then return end -- only the owner's client drives
	local root, dt = model.PrimaryPart :: BasePart, math.min(dt0, 1 / 30)
	local cf = root.CFrame
	local up, look, right = cf.UpVector, cf.LookVector, cf.RightVector
	local v, w, com = root.AssemblyLinearVelocity, root.AssemblyAngularVelocity:Dot(up), root.AssemblyCenterOfMass

	-- suspension: a spring and damper per wheel, an anti-roll bar per axle
	local comp, hit, normal, grounded = { 0, 0, 0, 0 }, {} :: { RaycastResult? }, Vector3.zero, 0
	for i, m in mounts do
		local h = workspace:Raycast(m.WorldPosition, -up * (REST + TRAVEL + RADIUS), probe)
		hit[i] = h
		if h then
			comp[i], normal, grounded = REST + TRAVEL + RADIUS - h.Distance, normal + h.Normal, grounded + 1
		end
	end
	for i, m in mounts do
		if hit[i] then
			local roll = 0.6 * springK * (comp[i] - comp[if i % 2 == 0 then i - 1 else i + 1])
			local damp = springC * root:GetVelocityAtPosition(m.WorldPosition):Dot(up)
			root:ApplyImpulseAtPosition(up * math.max(springK * comp[i] + roll - damp, 0) * dt, m.WorldPosition)
		end
	end

	-- tyres: the model's forces, applied on the CG's plane so the weight transfer is the model's, not the springs'.
	-- Keyboard, touch and gamepad arrive through the seat's floats; attributes override them (the scripted driver).
	local input: Vehicle.Input = {
		throttle = (model:GetAttribute("Throttle") or math.max(seat.ThrottleFloat, 0)) :: number,
		brake = (model:GetAttribute("Brake") or math.max(-seat.ThrottleFloat, 0)) :: number,
		steer = (model:GetAttribute("Steer") or seat.SteerFloat) :: number,
		handbrake = model:GetAttribute("Handbrake") == true or UserInputService:IsKeyDown(Enum.KeyCode.LeftShift), -- not Space: it exits
		digital = model:GetAttribute("Digital") == true or (model:GetAttribute("Steer") == nil and UserInputService:GetLastInputType() == Enum.UserInputType.Keyboard),
	}
	local forces = Vehicle.step(cfg, st, input, v:Dot(look), v:Dot(right), w, mass, dt)
	if grounded > 0 then
		for _, f in forces do
			root:ApplyImpulseAtPosition((look * f.ff + right * f.fr) * dt, com + look * f.f + right * f.r)
		end
	end
	root:ApplyAngularImpulse(-up * cfg.yawDamp * inertia * w * dt)
	-- vehicle gravity and the slope assist (see "Units and gravity")
	root:ApplyImpulse(Vector3.new(0, (workspace.Gravity - cfg.gravity) * mass * dt, 0))
	if grounded >= 3 then
		local g, n = Vector3.new(0, -cfg.gravity, 0), normal.Unit
		root:ApplyImpulse(-(g - n * g:Dot(n)) * SLOPE * mass * dt)
	end
end)
```
Server: on `Seat.Occupant` change `root:SetNetworkOwner(driver)` and `car:SetAttribute("OwnerId", driver and driver.UserId or 0)`; on Heartbeat `reset(car, lastUpright)` when speed > 330 or
a frame moved > 2·330·dt (`PivotTo`, zero both velocities, `Epoch += 1`); remember `CFrame` while `UpVector.Y > 0.5`. Wheel visuals: at `hit.Distance - RADIUS` down the ray, steered by the returned angle, spun by speed.
## Tuning, in the order that mattered
- **Launch.** First-gear drive was ~1.4x the rear grip, passed straight through (open diff, no limit): 100% rear slip for all of 1st gear, then a slow start. Fix: cap each
driven wheel at `launchLimit` (0.92) x its grip, so 39% of the lateral grip stays (`sqrt(1-0.92²)`), a clutch that revs the engine to its torque from a stop, a tyre curve that
falls to a plateau (`falloff` 1.3 -> 89% of peak, not a cliff), and the 0-100/0-60 test. Rear utilisation in 1st must stay <= `launchLimit`; never reach 100%.
- **Steering.** Full lock was sized by speed: 24.7° at 90 km/h where ~2.9° holds grip. Size it by grip: `atan(L·mu·g_v/v²)` = 13.7° at 60, 6° at 90, 2.4° at 150 km/h (floor 0.04 rad,
`maxLock` 0.6): full analog lock then gives 0.87-0.91 of `mu·g`, never a spin. Binary keys are rate-limited (2.4/s on, 4/s back: a 0.12 s tap = 1.5°); analog passes through.
Extra lock only toward counter-steer (`slideLock·|β|`), never into the slide.
- **Balance.** Every car had rear grip below front (0.96-0.97 vs 1.0-1.03): the rear always let go. Rear 5-8% above front is the stable base (1.06); measured at 90 km/h, a 1 s full-lock press
spun a 0.96 car to 89° and moved a 1.06 car 1-2°. Weight transfer is `h/L` (0.12 arcade, 0.2 sim: 0.2 made lift-off spins feed themselves), lagged 0.1 s, lateral transfer at half. Drift is initiated by the player.
- **Assists** add to the player's angle (`assist·front`), start at 10° of front slide and are full at 26°. They used to engage at 3° and fought the player. Gain must be <= 1: 1.2-1.5 swung
±40° every ~1.2 s with constant inputs (the 24°->61° limit cycle); 0.7 could not catch a slide. Hands off, the wheels follow the slide ("loose hands"); input adds to them.
- **Differential.** An open diff spins the unloaded inside wheel, so throttle barely changed the angle. `split` caps each wheel by its own grip: `diffBias` 3-4 = limited slip, 100 = locked, 1 = open.
- **Stability.** Explicit tyre forces once per frame oscillate: a held slide swung 14.7°/9°/3°/0.8° at 30/60/120/240 Hz before the fixes, and 0 (< 3°) at 30 and 60 fps after: yaw damping
(angular impulse `-yawDamp·I·w·dt`), half the lateral transfer, grip a smooth function of angle and pedal (no switches), a stop clamp (a wheel never reverses its slip in one step), a speed
floor in the slip angle, and a 1 stud/s band at standstill: a hard `speed == 0` test cancelled the drive force while creeping back at -1.9e-7 studs/s (car stuck after a switch).
## Presets (set on the arcade table; times are 0-100 km/h in the headless sim)
| field | arcade | drift | sim |
|---|---|---|---|
| gravity g_v / power (1st-gear drive, g_v) | 80 / 0.4 | 80 / 0.6 | 40 / 0.7 |
| muRear / peakSlip / falloff / transfer | 1.06 / 0.14 / 1.3 / 0.12 | 1.07 / 0.14 / 1.35 / 0.14 | 1.04 / 0.10 / 1.4 / 0.16 |
| diffBias / launchLimit / maxLock / driftLock | 3 / 0.92 / 0.6 / 0.8 | 4 / 0.92 / 0.6 / 0.9 | 3 / 0.95 / 0.5 / 0.8 |
| assist / yawDamp / driftLoss / angleGrip | 0.8 / 0.5 / 0.15 / 1.2 | 1 / 1.2 / 0.6 / 1.2 | 0.3 / 1.8 / 0.1 / 0.6 |
| 0-100 flat, 2.8° grade (assist 0.8) | 4.4 s, 4.6 s | 2.9 s, 3.0 s | 5.5 s, 5.7 s |
## Drift
- Entry (player-driven): handbrake (rear grip x0.55 while held, back in 0.5 s: a 0.3 s tap with steering at 85 km/h reached 30-35°), power-over (drive demand ~0.8 of rear grip in the entry gear takes the
lateral grip through the circle), weight shift (lift or brake, then steer: `transfer`), a clutch kick (raise `launchLimit` to 1 for 0.2 s). The preset never starts one by itself.
- Hold: from ~10° the pedal costs rear grip (`driftLoss`), so the throttle decides: drift preset at 0.6 closes within 1.5 s, at 0.85-1.0 it holds 35-40° at ~97 km/h for as long as held, a lift ends it in
under a second. Near `maxAngle` (0.9 rad) grip rises (`angleGrip`): every throttle has a stable angle, no spin. Keys ramp the throttle (2.5/s up, 6/s down) so tapping W modulates.
- Score: `angle° · km/h · dt · 0.02 · (1 + 0.15 · chain seconds)` while grounded, > 40 km/h and 15° < angle < 80°; bank it when the angle drops under 8°. No points for spinning or crawling.
- Full lock + full throttle at 50 km/h is a donut and fishtails by nature; keep it out of the constant-input check.
## Input, camera, feedback
- Keyboard: W/S/A/D or arrows through the seat's floats (binary: slewed above), handbrake LeftShift (Space exits the seat), reset R. Gamepad: stick x with 0.12 dead zone and `x·|x|^0.5`, R2/L2 analog
via `UserInputService:GetGamepadState`, handbrake ButtonX, no slew. Touch: the seat's floats (analog) plus on-screen buttons (`ContextActionService:BindAction(name, fn, true, ...)`) for handbrake and reset.
- Camera (`RenderStepped`, Scriptable only while seated, never roll): 16 back and 5 up from the car, its heading `lerp`ed 4/s towards the face direction blended <= 35% toward the travel direction
(the drift yaw), FOV 70 + 20·clamp(speed/250) eased 2/s. Never shake on grip loss or follow the car's raw yaw: drifts make the world swing and players sick.
- Feedback comes from what the car does, so every car in view works: sideways speed `s = |v·right|` -> tyre smoke rate 60·clamp((s-6)/14, 0, 1), skid trail when s > 8, squeal volume with s;
engine pitch `PlaybackSpeed = 0.6 + 1.4·rpm/redline` (rpm from speed and gear `tops`). No hit-stop. A bump sound when a spring bottoms.
## Acceptance checks (the engineer runs them and puts the numbers in the result; the critic re-runs them in its own playtest)
Drive the real car on the map's real track surface with the scripted driver (a Client `roblox_run_luau` in a playtest, driver seated). Headless numbers in brackets (arcade / drift / sim).
```lua
--!strict
-- Scripted driver: roblox_run_luau on the CLIENT of a playtest with the driver seated; the chassis reads the attributes.
local RunService = game:GetService("RunService")
local car = workspace:WaitForChild("Car") :: Model
local root = car.PrimaryPart :: BasePart
type Sample = { t: number, kmh: number, beta: number, yaw: number }
type Pedals = (t: number, kmh: number) -> (number, number, number, boolean) -- throttle, brake, steer, handbrake

local function drive(seconds: number, pedals: Pedals, digital: boolean?): { Sample }
	local out: { Sample } = {}
	local t = 0
	car:SetAttribute("Digital", digital == true) -- true: steer and throttle behave like keys
	while t < seconds do
		t += RunService.Heartbeat:Wait()
		local v, cf = root.AssemblyLinearVelocity, root.CFrame
		local kmh = v.Magnitude * 1.008
		local th, br, steer, hb = pedals(t, kmh)
		car:SetAttribute("Throttle", th)
		car:SetAttribute("Brake", br)
		car:SetAttribute("Steer", steer)
		car:SetAttribute("Handbrake", hb)
		table.insert(out, { t = t, kmh = kmh, beta = math.atan2(v:Dot(cf.RightVector), v:Dot(cf.LookVector)), yaw = root.AssemblyAngularVelocity.Y })
	end
	for _, k in { "Throttle", "Brake", "Steer", "Handbrake", "Digital" } do
		car:SetAttribute(k, nil)
	end
	return out
end
local function timeTo(tr: { Sample }, kmh: number): number
	for _, s in tr do
		if s.kmh >= kmh then
			return s.t
		end
	end
	return math.huge
end
local function span(tr: { Sample }, from: number): number -- how far the slide angle moves after `from`, degrees
	local lo, hi = math.huge, -math.huge
	for _, s in tr do
		if s.t >= from then
			lo, hi = math.min(lo, s.beta), math.max(hi, s.beta)
		end
	end
	return math.deg(hi - lo)
end

local function full(): (number, number, number, boolean)
	return 1, 0, 0, false
end
local function cruise(_: number, kmh: number): (number, number, number, boolean) -- hold ~80 km/h, constant steer
	return math.clamp((80 - kmh) * 0.08 + 0.3, 0, 1), 0, 0.4, false
end
local launch, steady = drive(8, full), drive(10, cruise)
print(`0-100: {timeTo(launch, 100)} s, straight yaw {launch[#launch].yaw}, constant-input slide span {span(steady, 4)} deg`)
```
1. **0-100 and 0-60 mph, flat and on the map's steepest launch grade** [4.4 / 2.9 / 5.5 s; 0-60 4.1 s]: within 15% of the preset, grade within +10% of flat with the slope assist (+24% without), rear utilisation in 1st <= `launchLimit`.
2. **Hands-off straight**: throttle 1, steer 0, 10 s from standing, then a lift at 150 km/h: |yaw| < 0.01 rad/s, slide < 0.5° [exactly 0]. No drift without input.
3. **Symmetry**: steer +0.6 and -0.6 at 80 km/h: yaw and slide mirror within 3% [identical].
4. **No limit cycle**: constant steer 0.3-0.6 and throttle 0.3-0.85 for 10 s at 50 and 90 km/h: the slide span after 4 s < 3° [<= 0.1°, at 30 and 60 fps; run once with dt = 1/30 in the chassis].
5. **Held drift follows the throttle**: handbrake 0.3 s + steer 0.8 for 0.5 s at 85 km/h, then steer 0.3 and throttle 0.5/0.7/0.85/1.0: the slide 1.5 s later never shrinks as the throttle rises [0, 0, -39, -42°], a held drift keeps
>= 25° for 5 s, a lift ends it (< 8° within 1.5 s), never > 90°.
6. **Keyboard tap vs hold** (`digital`) at 90 km/h: a 0.12 s tap turns the wheels <= 2° and the slide <= 1°, straight again within 1 s; a 3 s hold is a steady turn, wheels <= the grip lock (6°), slide < 3°.
7. **Reset/respawn** from a flip and mid-drift: upright (`UpVector.Y > 0.99`), velocity 0, gear and state fresh (`Epoch`), the same 0-100 time +-5%.
8. **A full lap** on the real track with a waypoint driver (steer by the angle to the next centreline point, throttle by corner speed): no stuck car for 2 s, no flip, no server reset, a lap time near what the speed allows; kerbs, seams and walls included.
## Traps
- Real-scale numbers on default gravity (5.6x): everything is grip-rich and slow. Raw drive force beyond the tyre's grip: the car peels out. Lock sized by speed. Rear grip below front. Transfer too strong.
- An assist that engages at 3° or has gain > 1. An open diff. A hard zero test at standstill. Tyre forces without the stop clamp: jitter at low speed and in reverse.
- `ApplyImpulse` given a force (needs force·dt). CFrame or velocity set every frame to steer: fights physics and ownership. Space as handbrake. Binary steering without slew.
- Testing on the baseplate only; faking a drift by lowering friction (rays have none: change the tyre model); leaving state (gear, `st`) after a reset; skipping the 30 fps run.
## Sources
- Network ownership https://create.roblox.com/docs/physics/network-ownership; VehicleSeat https://create.roblox.com/docs/reference/engine/classes/VehicleSeat; mechanical constraints https://create.roblox.com/docs/physics/mechanical-constraints
- Stud = 0.28 m (Game Settings, World panel) and Workspace.Gravity 196.2 https://create.roblox.com/docs/reference/engine/classes/Workspace; RunService (PreSimulation fires per frame, not per 240 Hz step) https://create.roblox.com/docs/reference/engine/classes/RunService
- Marco Monster, Car Physics for Games https://www.asawicki.info/Mirror/Car%20Physics%20for%20Games/Car%20Physics%20for%20Games.html; friction circle and combined slip https://www.racer.nl/tutorial/combined_slip.htm; Pacejka Magic Formula https://www.racer.nl/reference/pacejka.htm
- Measured in a headless Luau sim of the module (60 and 30 fps) and the first build's playtests; the chassis glue was linted, not run: verify it with the checks above.
