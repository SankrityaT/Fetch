# The compositor's passes

One frame of an edit, in the order `gl.js` draws it. Every pass is a function of the
plan (`plan.prepare`), the frame's own plan (`plan.framePlan`) and the source pixels
for that frame; nothing reads the previous frame, so any frame can be drawn alone and
the editor's stage and the export draw the same pixels. Film grain and dither are
seeded by the frame index, motion blur is analytic (its shutter reads the derivative of
the zoom's ease, which is a function of time and never an integration over frames), the glow family comes off this
frame's own bright pass, and the take's own black and white points are measured once per
take in the main process (`prepare.js`, for auto level, for the glow's threshold and for
the ends of the grade's own curve), which is what keeps that true.

A cut transition is the one thing here that asks for two source frames at once, and it
is still not a filter over two drawn frames: `framePlan` solves both sides' take times
and the weight between them from the output time alone (`plan.js`, `srcPair`), and the
frame is drawn once per side and mixed before the last pass (14a). So a dissolve renders
out of order like everything else, and the last pass, where the grain, the fade and the
dither live, still runs once per output frame. A caller says which side it is holding,
and a caller with no far side to give (the stage while its second `<video>` is still
seeking, a still whose far decode came back with nothing) says nothing and gets one
plain draw of the near side. Read off `fp.mix` alone instead, that stashed the near side
and wrote nothing at all, so the stage held the frame before for the whole window and a
still could be written from the still before it. The take arriving and leaving
(`motion.reveal`) and a dip through the ground ride the same machinery a title card's
landing does, `fp.move`, which the frame pass reads as `uTake`.

Everything Fetch draws over the recording arrives and leaves, and one function says how
far in any of it is: `Overlays.fadeLevel`, the S a lift already dims a page with. DESIGN.md
gives `--ease-in` to a thing entering and `--ease-out` to a thing leaving, and both are
right for a shape and only one of them is right for an alpha: `--ease-out` accelerates, so
read as an opacity it spends half its window between 1.00 and 0.68 and crosses the whole
readable range in the last third. A step badge given 220 ms to leave was gone inside 83 of
them. So what leaves moves on `--ease-out` and fades on the S, over three fifths of its own
arrival, never under `--dur-1`, and badges that share an end clear in the order they
arrived rather than all on one frame. A redaction is the exception and always was: a fade
shows the secret, so it is on from its first frame to its last.

A pair of fades is cut to the room it has (`Overlays.fitFades`), keeping its ratio. A
caption phrase is floored at one arrival's worth of screen time (`phraseTimes`), so a
phrase handed straight on to the next one is exactly as long as its own arrival, and
asked for both ends anyway it never reached full here and libass read the two knots of
a `\fad` out of order over there: the words ramped up across the whole line and cut out
in a single frame. Cut to fit, a short phrase still comes up and still leaves, and the
stage and the ASS the classic renderer writes still agree.

Two things travel through these targets: a picture, and a mask. Alpha is never opacity
here, it is how much of a pixel is the recording. The frame pass writes it (1 on the
take and the camera, 0 on the ground and the border), the steps, the cursor and the text
carve themselves out of it by the part of a pixel they actually cover rather than by the
alpha of the shadow they cast, and the treatment pass reads it to hold the grade to the
take. Held to it properly: at the take's own antialiased edge the pixel is part
recording and part ground, and grading that blend at the mask's weight is not the same
as grading the recording's share of it, so the treatment pass grades the whole pixel and
hands the ground's share back ungraded. The line it draws: a lens and a roll of film are in front of the whole frame, so
blur, aberration, bloom, halation, the vignette, grain and dither land on everything;
the grade is of the picture the camera took, so brightness, contrast, saturation, tint
and auto level stop at the recording. Haze goes with the lens (light scattered on the
way in, and held to the take it would lift the take grey against a clean ground and make
its edge a break). The ground is a colour the look chose and is already the colour it
should be; a badge, a cursor and a caption are Fetch speaking over the recording, and
Fetch does not speak in grey.

The ground is a surface, not a value. One number across 1920x1080 is a CSS background,
and what makes the difference is a tooth and a pool. The tooth is three levels of luma
either side, fixed whatever luma the look chose, because the film's own grain is
weighted for the midtones and four of the seven looks put their ground at an end of the
range, where that weighting left it a fifth of a level over the dither. Three levels,
and never more than the film leaves on the picture: a roll of film is in front of the
whole frame, so where a look has grain the film is what the frame's texture is and the
ground's tooth sits under it (`plan.js`, `spec.tooth`, measured at the end of the range
because a screen recording's picture is an app page and that is where the weighting
leaves least). Ground three to five times grainier than the take inside it was the one
thing the third taste pass called an inversion, and it was most wrong on the two looks
whose whole identity is the grain. The weighting itself now keeps six tenths at the ends
rather than a third, so the page is not exempt from the grain a look asked for. Where a
look asks for no film there is nothing in front of anything: the tooth keeps its three
levels and the recording is given no grain nobody asked for. The pool is the
app's own: `tokens.css` lights the body with two very wide, very faint pools of
`--fur-1` in opposite corners, and the export is of the same product, so the colour and
the geometry are read off the stylesheet rather than invented. It goes on the still
background, which is drawn once per plan, so it costs nothing per frame; the tooth is
seeded by the frame index, like the film and the dither, so any frame still draws alone.
Three levels of the export's own pixels, so on a stage drawn below the file's size the
tooth comes down with the size the way the film's grain already does: four export pixels
seen as one average to half the noise, and a ground twice as gritty as anything that
will be exported is a different ground. And seeded through the film's own clock: one
draw of grain and tooth lasts the whole of `grainHold` output frames, one at 30 fps and
two at 60, so a look grains the same at both rates instead of boiling twice as fast at
the higher one, and the seed is still a function of the frame's own index.

The take's edge is a contract rather than whatever that ground happens to leave. The
floor is 24 levels of luma between the take's outermost pixels and the ground beside
them, in either direction, and the frame pass meets it with whichever of three is
available: a blur ground that holds near the take's own mean, a shadow wide enough to be
felt and narrow enough to resolve inside the gutter, and a warm hairline where neither
is enough. A distance, not a direction: an edge already standing clear of the ground on
the other side asks for nothing, and hands the requirement back over a window rather
than at a step, so nothing switches along the perimeter. The line stands clear of the
take as well as of the ground, since a hairline drawn on the take's own tone is not a
hairline; its tone is the one end the plan picked and stays there, and where that end
cannot carry the floor against the take it delivers what it has and no more. A gutter
is never a bar: a ground made of the take's own blur never stands more than 64 levels
under it on the finished frame, fall-off and all.

Geometry is in export pixels (`layout.js`, the one geometry every renderer uses) and
scaled to whatever the compositor draws at: the export's size, or the stage's. What is
drawn on the recording itself is in content pixels (the cropped take at its own size),
scaled to the texture it is drawn into.

Since M5 the framed take lies on a plane rather than on the frame. `frame.tilt` turns
that plane about the vertical axis through its own centre and projects it from a camera
2.2 frames away, and the frame pass reads the turn backwards: every output pixel is
asked which point of the flat plane it shows, and the rounded mask, the border, the
shadow, the camera bubble and the device's shell are then worked out on the plane
exactly as they were before tilt existed. So the mask follows the perspective because it
is the same mask, and the shadow follows it because it is cast on the plane rather than
painted under the finished picture: neither is a skew of anything. The plane is shrunk
by as much as the projection's near edge grows, so a tilted take asks for exactly the
room the flat one had and its near corner cannot reach past the frame. The ground is
still read where the pixel is and the shadow where the plane is, which are the same
place until a tilt separates them; the grade is held to the picture, so the treatment
pass reads the plane too (`uTilt` there is the same three numbers). At tilt 0 there is
no plane at all: the substitution is the pixel itself and every frame is byte for byte
what it was.

The device (`device.kind`, and `frame.chrome: clean`, which is the browser one on its
own) takes the place the layout gave the take and hands back what is left, so the
margins, the shadow and the whole composition stay where they were and only the take
gets smaller. It is one Canvas2D picture with a hole where the screen is, made once per
plan and size, so a frame costs one textured quad. Its two edges are each a pair of
tones a range apart, the shell and a hairline just inside it: whatever an edge meets,
the page inside or the ground outside, it cannot be within the edge floor of both, so
the contract pass 9 measures per pixel is met here by construction and the two decode
paths cannot land on opposite sides of a threshold. That is why `spec.edge` is null
under a device: a second line inside the screen would be a line drawn on a line.
Every shape is generic by construction and by intent. Nothing is traced, nothing carries
a wordmark, a window's three dots are the shell's own tone and never one desktop's three
colours, a laptop is a slab and a shallow foot with no keyboard and no hinge, and a
phone has a speaker slit and nothing else.

Two things about it are decided later than the rest of the plan. Its tone goes the way
the take's own hairline goes, graphite on a dark ground and bone on a light one, and a
photo is the ground neither can read until it is decoded: the plan calls every image
light, which is the safe end for a hairline and the wrong one for a shell, so a device
on a photo starts graphite and `gl.js` re-picks it from the decoded mean (`deviceOf`,
beside `edgeOf`, off the same eight by eight read). And the browser frame
`frame.chrome: clean` asks for is drawn only where the page's own place in the window is
known, because that is what let the real chrome be cropped away: with no viewport
nothing was cropped, a drawn bar would sit above the recording's own tabs, and Fetch
draws none and says so (`Look.warnings`).

Captions are laid out against the take's own place on the frame rather than against the
screen inside the shell. The band a burned caption sits in is the room the layout left
under the take, and a device stands in the take's place rather than beside it, so laid
out from the screen a caption walked down into the device and landed on a laptop's foot.
A lower third still rides the screen, because it lies on the product.

| # | Pass | Target | Per frame | Notes |
|---|---|---|---|---|
| 1 | source | `content` (RGBA, mipmapped) | when the frame changed | NV12 from ffmpeg (export) or the `<video>` (stage). BT.709 limited, chroma centre-sited; BT.601 under 720 lines, as Chromium does. Mips so a Retina take minified into 1080 does not alias. |
| 2 | camera source | `cam` (RGBA, mipmapped) | when the camera frame changed | Its centre square at its own size, so both paths sample it on the GPU. |
| 3 | still background | `bg` | once per plan and size | Gradient corner to corner in sRGB (a solid is a flat gradient), with the app's own two warm pools laid over it in the corners `tokens.css` puts them in, at the stylesheet's own colour, reach and opacity (a mesh has its own places of colour and a photo its own light, so this is the branch with a flat field to answer for); a mesh, its control points blended by normalised Gaussian weights in the same sRGB; an image covered, dimmed, and blurred at a quarter size, through a hexagonal aperture rather than a Gaussian while the look asks for bokeh. The aperture is a gather on four rings, so the cover is softened to the gap between its taps first, or a photo with detail at that scale comes back as eighty-one copies of itself instead of one aperture. |
| 4 | blur ground | `fillA` (tiny) | yes | The cropped frame shrunk to 1/64, Gaussian blurred (the classic 125 px at 1080 for blurAmount 0.5), or through the same hexagonal aperture, softened to its tap spacing first, while the look asks for bokeh. Pressed in the frame pass, where the treatment's share of the vignette is divided back out of it so the ground keeps one fall-off rather than two. The press alone is right for a dark take and ruinous for a bright one, where it put a 51 fill against a 236 page and called it a ground, so the pressed luma is lifted to within 64 levels of the take's own mean at that point. A lift on the luma, so the classic chroma press still stands: scaling the whole colour to hit a luma erased the fall-off and left the gutter more saturated than the take it came from. After the fall-off and before the grain: the band is a promise about the finished frame, and taken before the vignette the fall-off spent a fifth of the gutter on top of it, so the default look's 64 levels measured 108 to 126, a grey mat down both sides of a white page. The fall-off survives wherever it stays inside the band, which is what it was always for, and the grain lands on the gutter either way. The take it is measured against is what the treatment's vignette will leave of the take, so both ends of the contract are read on the same finished frame. It only ever lifts, and never under zero: a take too dark to stand a gutter under it has nothing to be lifted from, and its edge is the hairline's to keep. |
| 5 | clean | `contA` (the crop's size, mipmapped) | while anything is drawn on the take | The crop copied out; the Mac's pointer filled from its box's edges (delogo's weighting); redactions as cells, each the mean of what it covers (16 finished px or a third of the box's short side, whichever is larger). Clean patches of a resting pointer (`prepare.js`) laid over as pictures. |
| 6 | blur marks | `contA` | while one shows | The box and its margin shrunk from a mip level, blurred, and laid back through a round-cornered mask at the mark's opacity. A plate, with its own corner, an edge feathered over about two finished pixels and no further, and a hairline just inside it off the plate's own tone, drifting with that tone rather than choosing between its two ends at mid grey (a two-way choice at a step is 67 levels wide and the two decode paths differ by one, so a ring pixel either side of it landed on opposite ends): a blur has to read as something someone put there, and a patch that fades out over twenty pixels with no boundary reads as a render that went soft. |
| 7 | focus | `contB` | while a lift or spotlight shows | Spotlight: a feathered window at full light in a dimmed, lightly blurred page. Lift: the element's own pixels scaled 3 to 6 percent about its centre (and moved in from a frame edge), cut with its own corner radius, over a wide key shadow and a tight contact shadow (analytic), the page behind blurred and dimmed by multiplication, less by the piece and more with distance. Up to four at once. |
| 7a | loupe | `contC` | while one shows | A magnified inset of a small area, beside the area it magnifies, over a key and a contact shadow, with a hairline round its own edge and a thin outline round the area. Its own target, because a pass that magnifies part of a picture has to read that picture somewhere other than where it writes. Last of the marks, so what it magnifies is what the frame now shows: a redaction under a loupe is redacted inside it, and a lifted card comes up inside it. Its pixels are the recording's, so they keep the mask and the grade grades them; the two lines are Fetch's own and carve themselves out of it. Placed inside what the zoom it rides shows rather than inside the recording, and sized against that window too, the way a lift is pulled back in (`Focus.nudge`): picked against the whole frame, an inset on a 2x window went off the side of it and the viewer saw a cut sliver with its hairline chopped. Up to two at once. |
| 8 | steps and cursor | the content target | while they show | Canvas2D pictures drawn once per size (`pic`): step badges popping in and shrinking away, riding a lifted card; the agent's arrow pressing on clicks, its gold ripple, the Biscuit tag and badge. Mipmapped after, so a zoom samples them like the take. None of it was on the screen that was recorded, so each carves its own coverage out of the mask in that target's alpha and the grade leaves it alone. Its coverage, not its alpha: a badge's drop shadow and a caption's blurred glyph cloud lie over the recording at a third of an alpha, and the recording under them is still the recording. Carved by the whole of that alpha, a look that takes the colour out of a take left a soft coloured halo ninety pixels wide round every badge, the agent's cursor and every caption over the picture. |
| 9 | frame | `scene` (mipmapped) | yes | Writes the mask as well as the picture: 1 where the take or the camera is, 0 on the ground, under the border and the camera's ring, and less wherever pass 8 drew something of Fetch's own, carried through the same taps and mip level so a badge minified by a zoom masks exactly what it covers. Background with the ground's tooth on it (or the blur ground: luma 30%, chroma 80%, cos^4 vignette, the same tooth), the tooth being on the ground the eye sees and not on the ground the edge floor reads below, since the floor is a distance between two tones and three levels of tooth is not a tone, the analytic rounded-box shadow (wider than the classic boxblur, because a shadow nine levels deep and gone inside 25 px reads as a hairline of dark rather than as elevation, and capped against the margin the frame leaves so the pool resolves before the canvas ends rather than darkening the last row by a tenth), the take (or the content target) inside an SDF rounded mask with a 1 px edge, zoomed (`Overlays.zoomView`, lifts re-framing the zooms they ride and the moment after a re-framed one panning from where it actually landed) with the window margin trimmed and covered, the focus held inside the picture by where it sits in the travel a window of that scale has rather than by a clamp read at every instant (`Overlays.focusFrac`): the constraint is the same one and it is met by construction, since the travel is concave in the ease and so never falls under the line the focus rides, and the one frame a pan used to stop riding the frame's edge on no longer changes speed by a fifth. The ease-back in the middle of a far pan is bounded so the window is never wider than the frame, motion blur as samples across the shutter scaled with pixel travel (up to 32), the travel being the
zoom's own velocity at that instant (the analytic derivative of `Overlays.easeAt`, not a
difference between two drawn frames) and the shutter being the camera's: 180 degrees by
default, which is what `treatment.motionBlur` sets and all it sets. So a fast pass smears,
a settle does not, and a held frame takes one sample and is byte for byte what it was.
The shutter never sees both sides of an edit: a push jumps the view on the boundary, so
the exposure is held to just inside its own frame's side of it, and a boundary almost
never lands on a frame. It is velocity per *output* second, which is why a clip's rate
reaches it: `plan.js` reads the rate at the moment being drawn and scales the travel by
it, so a 4x section smears four times as far as the same pan at 1 rather than a quarter
of the truth. The rate is read in `plan.js` and never in `gl.js`, which is what keeps
speed out of the frozen file. Then a border, and the camera bubble, which rides the take rather
than sitting beside it: the same scale about the frame's centre, the same drop and the
same opacity, so it arrives with the take, leaves with it and goes with it through a dip.
Drawn in its landed place it sat at full size over a take that had not arrived yet and
stayed lit over bare ground on the one frame a dip takes the take off the screen. The pass also keeps the edge floor: the take's outermost pixels stand at least 24 levels of luma off the ground two and a half pixels outside them, read along the edge's own normal with the shadow at that point, and where they do not a hairline about a pixel and a quarter wide makes up the difference at exactly the opacity that lands on the floor. Clear of the further of the two by the floor, take or ground: measured off the ground alone the line landed inside the take's own tone wherever a lift had dimmed the page to the ground's own level, a Paper page at 194 wearing a line at 193 under a ground at 214, and a third of Mono print's perimeter went under the floor that way. The floor is a distance: an edge already clear gives the requirement back over a window rather than at a step, whichever way it stands clear, two floors wide where the line would be going on past the ground and one where the take itself is the far one of the pair. The opacity is a distance rather than a signed target, so what arrives is the smaller of what was asked for and what the tone it has can carry, and it is continuous where that tone passes through the take's own: read as a signed target, the denominator through zero swung the full range across half a level of the take's pixels and left a solid rim in one decode path and none in the other. It goes to the warm end that ground leaves open, ink over a light ground and a warm light over a dark one, chosen once per plan from the background the look asked for (`plan.edgeEnd`) rather than per pixel: a gradient crosses mid grey along one edge, and a line that changed ends where it crossed would put a seam down the frame and land the two decode paths on opposite sides of it. One end, and it does not travel: letting it drift to the other one where a lift had dimmed the take onto the plan's own tone was tried and taken out. The two ends are the range apart, so the drift carried the line's tone across the take's own luma, and one level of the take either side of that crossing took the finished pixel from a floor above the take to a floor below it, thirty levels of swing where the rest of the plane moves under three. That is a hairline that pops while a lift fades a page and crawls along an edge, and since the two decode paths differ by a level it is a solid rim in one and none in the other, which is the fault the line exists to stop. What is left is the honest shortfall: where the plan's end sits within a floor of the take's own edge the line delivers what that tone can carry and fades out over the last few levels. On the seven presets that is a percent or two of one perimeter under a lift, all of it between 20 and 24 levels and none of it under 20, which is the grain and the lens in front of the line rather than the line. The line is a colour Fetch chose, like the border, so it carves itself out of the grade's mask by its own share of the pixel. Under an opening title card the take waits, then rises into place; under a closing one it settles back (`text.frameMove`). |
| 9a | device | `scene` | while a look draws one | The drawn frame round the take (`device.kind`, `frame.chrome: clean`): one Canvas2D picture with a hole where the screen is, lying on the take's own plane, blended over the frame pass and carving its own coverage out of the grade's mask. A browser (a bar, three dots in the shell's tone, an address pill that shows `device.title` and nothing when there is none, because Fetch records no page address and never invents one), a plain window, a laptop (a chin and a shallow tapered foot with a thumb notch) or a phone (a uniform bezel and a speaker slit). Made once per plan and size like every other picture here, so a frame costs one textured quad; a look that asks for no device draws no pass at all. |
| 10 | card ground | `scene` | while a title card shows | An opening card's near-black scrim; a closing card's frame blurred about 130 px at 1080 and half desaturated under the scrim. |
| 11 | caption plate | `scene` | while a caption over the take shows | The frame blurred at a quarter size, through a feathered rounded patch at the words' own bounds, with a scrim mixed into it: the far end of the words' own colour, so a light caption gets a dark plate and an ink one a light plate. Glass alone is the frame's own luma, and a white caption over a blurred white page is still a white caption. Framed or not, and unframed is the case that needs it: with no band to sit in, the caption fell back to the shade's own blurred cloud of glyphs, a smudge with no boundary, on the default look, at every caption. The classic renderer frosts only a framed caption, because libass cannot blur what is under it and the alphamerge wants a band whose size is known exactly, so this is a divergence and a deliberate one: the compositor knows the frame it is drawing. |
| 12 | text | `scene` | while text shows | Captions (their shade, which is the blurred cloud of their own glyphs where the words have no plate and the drop under the glyphs alone where they have one, so nothing a plated caption draws reaches past the plate's own bounds and the thing that shades the words goes wherever the dodge puts them; a pill under the spoken word, the words with the spoken one re-tinted), titles rising out of a blur (a crossfade to a blurred copy), lower thirds, labels. Laid out by `text.js` with `overlays.js`, rasterised with Canvas2D once per item and size. Every word and a title card's scrim carve themselves out of the mask; the caption plate of pass 11 does not, because it is mostly the frame's own light through a patch and belongs to whatever it lies on. |
| 13 | treatment | `treat` | while the look asks for any of it | The lens, the film and the grade over the finished frame, in that order, because that is the order light meets them. The lens: the whole frame softened (blurred at a reduced size off mip levels, as the blur ground and the caption glass are) and its channels parted towards the corners, growing with the square of the distance from the centre, usually by a fraction of a pixel. The film: bloom and halation, both off one bright pass of this frame at a quarter size and one mip chain of it, bloom reading the tight levels and halation the wide ones, warm, so two effects cost one blur. The bright pass reads what is at the take's own white point, a shade under it, rather than above a level the dial alone chose: a page white is not a highlight, and a glow that reads a grey glyph on one puts a warm collar round it. That white point is `levels.js`'s, and `prepare.js` measures it for a look that glows or auto levels, and for the one grade the pair can still move: a contrast with a brightness on it. With a contrast alone the run below is set by the slope the curve has to arrive carrying, for every pair `levels.js` can return (its white never under 170, its black never over 64), so a look that grades and nothing more is not worth a demux and four hundred keyframes of a long take before the stage draws its first frame. Unmeasured the white falls back to 1, and a dark-mode take, whose highlights top out well under white, then had no bloom and no halation at any setting. Each texel of the pass judges its own 4x4 box of the frame and the results are averaged, not the other way round: with the knee this close to white a mean is almost never over it, and averaging first left the glow reading flat white and nothing else, and at a preview's size nothing at all. A highlight narrower than that box lands differently at the two sizes the compositor draws, which is a half-size stage holding less detail than the file and not a disagreement about the plan. Then the grade, held to the recording by the mask in `scene`'s alpha: auto level (the take's own black and white points, measured once by `levels.js`, never per frame, and held to the take's own rect and corner as well, since those numbers came from the take's pixels and would reach the camera bubble otherwise), contrast about mid grey then brightness, with both ends of that straight line rolled in rather than cut off (`plan.js` `rollOff`: the line runs to a knee, then a cubic carries it onto the range's end, and the same curve mirrored at 0), each knee pinned to the take's own measured end or to the slope, whichever asks for the longer run: the run starts at the take's white where there is room above it, so the overshoot is spent on what the take has nothing in, and where there is none, which is what a white app page's white two levels under the range's end leaves, it reaches down into the picture far enough that the curve still arrives carrying 1/gain of the line's slope. That is the slope the picture had before the grade, so a hairline at the top of the take is never flatter than it was ungraded. It arrives carrying slope rather than flat, which is the whole of it: arriving flat put the one place the curve has no slope left exactly on the page white, and the product's row separators were compressed into it two and a half times: of the eight the library list draws in one column, Noir kept none of them 8 levels deep and Mono print one, against eight on every look that does not grade (`.context/survey/r3-white.md`). Auto level has already put a measured take on 0 and 1 by the time the grade runs, so there the two ends are the range's; an unmeasured take is taken to fill the range, which is the same pair, and the slope the curve keeps is what makes that safe. Then saturation, a tint multiplied in with the luminance put back (a photo filter). `eq` clips, and a clip on a white app page is every row separator and card hairline in the product deleted. Where the mask is whole the grade is the only thing that touches the pixel, byte for byte as it was before the mask existed; where it is nothing, as on the ground and on every badge, cursor and caption, the grade is not run at all. At the take's own antialiased edge, where the mask is neither, the pixel is part recording and part ground, and the grade is affine, so the whole pixel is graded and the ground's share handed back ungraded, the ground read a couple of pixels outside the edge along its own normal: grading the blend at the mask's weight instead left a quarter of the take's own colour ungraded and took a quarter of the ground's warmth off, a closed coloured rim round a picture a black and white look had just drained. Then haze, over everything, lifting the blacks toward the frame's own colour (its deepest mip level). Last, the corners falling off with the blur ground's own cos^4 vignette, so the frame and the ground behind it fall off together and once: the ground is drawn with this pass's share of the vignette already taken out (pass 4), and only the take carries it twice as far as its edge. The dial is how many of that fall-off, not a share of one (`plan.js` `VIG_REACH`): one of them takes 28 levels in a hundred off the frame's furthest corner and 15 off the take's own, which is the right shape to hold the ground and the frame together and far too small for a dial, and Noir asking for 0.35 of it measured 6 percent on a look whose identity is the vignette. It scales the mix and nothing else, so what the ground divides back out stays exactly what the treatment puts on. Bokeh is not here: it is the background's own defocus given an aperture's shape, in passes 3 and 4. Skipped whole at a default look. |
| 14 | final | `out` | yes | Film grain, seeded by the frame index through the film's own clock (one draw per output frame at 30, one per two at 60) and quantised to a cell sized on the export's grid, heaviest in the midtones and six tenths of that at the ends of the range rather than a third, since the page a screen recording is of sits at one end; on a stage smaller than the export the cell goes under a pixel rather than being clamped up, and its strength comes down with it, because that is what the file's own grain becomes at that size; then the fade to and from black over the whole frame (so a frame fading out does not keep grain on black); then a one-step triangular dither seeded by the output frame itself, not by the film's clock, because the dither is the last step of writing the frame out rather than part of the picture, and it stays the last thing that touches a pixel. |
| 14a | dissolve | `sideB` | only inside a cut being dissolved (`motion.cutTransition: crossfade`) | The same output frame drawn twice, once from each side of the cut, mixed by `fp.mix`. Both sides are the frame's own time (`plan.srcPair`): the outgoing piece running on into the material the cut removed and the incoming piece starting inside it, each at the take's own rate, so no output time is added and nothing already seen is shown twice. The mix is the zoom's own quintic with no warp, so it is exactly half on the boundary the timeline names. Before the final pass, so grain, fade and dither stay one per output frame. A dip (`dip`) and a push (`zoom`) need none of this: they are one source frame, `fp.move.alpha` and a tightening of the view. Each side reads its own marks: both sides are playing inside the material the cut removed, and a mark is placed on the output clock, where that material has no time at all, so a redaction keyed to output time had already ended on the boundary while the outgoing side ran on past it and the secret was legible under frame stepping. The outgoing side takes the last instant before the cut and the incoming one the first instant after it, which is where their own source times went when the clock closed the gap (`fp.marks` and `fp.marks2`). What no instant of the output clock can speak for is a mark that begins or stops inside the frames the dissolve shows, and the window stops short of those or the cut stays hard (`plan.js`, `cutRoom`). |
| 15a | present | the canvas | stage, and the WebCodecs sink | Flipped. |
| 15b | pack | `packed` (RGBA8, ceil(W/4) x 1.5H) | export | Exact NV12 bytes, BT.709 limited, chroma as the 2x2 mean, read back through a ring of three pixel-pack buffers. |

What only the take's pixels can say (a lift's element on screen and its box and corner,
a step's card corner, the Mac's pointer and its clean patches, the cursor's rests off
the words, whether the bottom of the frame is any place for a caption: a toast arrived
there, or the product's own content is simply there and the top is clear) is worked out
once in the main process by `prepare.js`, cached, and shared by the editor's stage and
the export; frames are then drawn from the plan alone. Everything there that maps a
source second to an output one takes the rates with the cuts (`Timeline.outClock`'s
fourth argument): the auto zoom's moments, the caption dodge and its memo key, and the
same clock in `render-host.previewFrames` and the editor's stage. Left out of any one of
them, that surface placed its work on a clock where speed did not exist and the stage
drew a different frame at the same output time than the export did.

Sources and sinks (M0 decided, M2 measured):

- Decode: ffmpeg, VideoToolbox, over loopback TCP in a Web Worker (a pipe reads 8 KB at a
  time in Electron). Only the runs of frames the plan shows are decoded (`select` on the
  container's own timestamps with `-copyts`); sample and hold is `plan.frameMap`.
  `scale_vt` shrinks a take far larger than the deepest zoom needs before the download.
  A still (preview_frame) decodes its one frame and stops (`-frames:v 1`).
  The rate it holds onto is `Timeline.outFps`, 30 or 60, and which one is read off the
  take's cadence (the median gap between its frames) rather than off the average ffmpeg
  reports: a native take has no single rate, so the average is the refresh less every
  still passage, and a take whose screen steps at 1/60 of a page that sits still for
  half its length reads 26, went out at 30, and had 516 of the 1234 frames it did
  catch thrown away. No rate makes sample and
  hold clean on a take whose frames land 15 to 20 ms apart, so the one to ask for is
  the one a player runs at 1:1 (`.context/survey/m5-timing.md`).
- Encode: x264, fed packed NV12 over loopback TCP (a pipe from the renderer took 144 fps,
  a socket 740). On the Songscription tour at 1080p60 it wrote 5.9 MB where VideoToolbox
  and WebCodecs wrote 71 to 73 MB at the bitrate that keeps text sharp; those two stay as
  `sink: 'vt'` and `sink: 'webcodecs'` for measuring. What this encoder is handed is not
  what the classic renderer hands it: the ground has a tooth and four looks put a roll of
  film in front of the frame, and an encoder's first move on fine noise over a flat field
  is to throw it away, so the tooth three taste passes scored off PNGs was not in the file
  anyone played (`.context/survey/m5-fades.md`). At `high` the encoder is told what it is
  looking at (`sinks.js`, psy-rd, aq-mode 3, no-dct-decimate, a softer deblock, on the
  `fast` preset with one step of rate factor to pay for them): the delivered picture is
  the one it was, mean absolute difference 1.22 levels against the drawn frames where it
  was 1.25, and the ground moves on every frame of a still passage where it used to stand
  still for up to seventeen. At `balanced` and `small` nothing carries it at any tuning,
  and they keep the encoder they had.
- Sound: ffmpeg in the main process at the same time (`processor.renderAudio`), then a
  stream-copy mux and the music bed.
