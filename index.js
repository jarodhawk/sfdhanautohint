var fs = require('fs');
var readline = require('readline');
var stream = require('stream');
var autohint = require('./autohint');

var instream = fs.createReadStream(process.argv[2]);
var outstream = fs.createWriteStream(process.argv[3], { encoding: 'utf-8' });
var rl = readline.createInterface(instream, outstream);

var n = 0;
var buf = '';
var curChar = false;

var PPEM_MIN = 10;
var PPEM_MAX = 36;
var MAX_SW = 4;

var cvt = [0, 840, -75];
for(var ppem = PPEM_MIN; ppem < PPEM_MAX; ppem++){
	for(var w = 1; w <= MAX_SW; w++){
		cvt.push(-Math.round(1000 / ppem * w))
	}
}

rl.on('line', function(line) {
	buf += line + '\n';
	if(buf.length >= 40960) {
		outstream.write(buf);
		buf = '';
	}

	if(/^SplineSet/.test(line)) {
		curChar = { input: '' }
	} else if(/^EndSplineSet/.test(line)) {
		if(curChar){
			if(n % 100 === 0) process.stderr.write("Hinting glyph #" + n + '\n')
//			try{
				generateInstruction(curChar);
				if(curChar.instructions) buf += "TtInstrs:\n" + curChar.instructions + "\nEndTTInstrs\n";
//			} catch(ex) {

//			}
			n++;
		}

		curChar = null;
	} else if(curChar) {
		curChar.input += line + '\n';
	} else if(/^DEI:/.test(line)) {
		buf += 'ShortTable: cvt  ' + cvt.length + '\n' + cvt.join('\n') + '\nEndShort\n'
	}
});

function roundingStemInstrs(glyph, ppem, actions){
	var tt = [];
	for(var k = 0; k < actions.length; k++){
		var sw = actions[k].bottomkey[3] | 0;
		if(glyph.nPoints < 256 && sw > 0 && sw < MAX_SW) {
			tt.push('PUSHB_3', actions[k].bottomkey[2].id, 3 + MAX_SW * (ppem - PPEM_MIN) + (sw - 1), actions[k].topkey[1].id,
				'MDAP[rnd]',
				'MIRP[0]')
		} else {
			tt.push('PUSHW_3', actions[k].bottomkey[2].id, -(actions[k].bottomkey[3].toFixed(0) * 64), actions[k].topkey[1].id,
				'MDAP[rnd]',
				'MSIRP[0]')
		}
	}
	return tt;
}
function alignedStemInstrs(glyph, ppem, actions){
	var tt = [];
	for(var k = 0; k < actions.length; k++){
		var sw = actions[k].bottomkey[3] | 0;
		if(glyph.nPoints < 256 && sw > 0 && sw < MAX_SW) {
			tt.push('PUSHB_5', actions[k].bottomkey[2].id, 3 + MAX_SW * (ppem - PPEM_MIN) + (sw - 1), actions[k].topkey[2].id, 0, actions[k].topkey[1].id,
				'SRP0',
				'MIRP[10000]',
				'MIRP[0]')
		} else {
			tt.push('PUSHW_5', actions[k].bottomkey[2].id, -(actions[k].bottomkey[3].toFixed(0) * 64), actions[k].topkey[2].id, 0, actions[k].topkey[1].id,
				'SRP0',
				'MIRP[10000]',
				'MSIRP[0]')
		}
	}
	return tt;
}

function pushargs(tt){
	var vals = [];
	for(var j = 1; j < arguments.length; j++) vals = vals.concat(arguments[j]);

	var datatype = 'B';
	var shortpush = vals.length <= 8;
	for(var j = 0; j < vals.length; j++) if(vals[j] < 0 || vals[j] > 255) datatype = 'W';
	if(shortpush){
		tt.push('PUSH' + datatype + '_' + vals.length);
		for(var j = 0; j < vals.length; j++) tt.push(vals[j])
	} else if(vals.length < 256) {
		tt.push('NPUSH' + datatype);
		tt.push(vals.length);
		for(var j = 0; j < vals.length; j++) tt.push(vals[j])
	}
}

function generateInstruction(ch){
	var glyph = autohint.findStems(autohint.parseSFD(ch.input), 20, 140);
	if(!glyph.stems.length) return;
	var tt = ['SVTCA[y-axis]', 'MPPEM'];
	var cvts = [];
	for(var ppem = PPEM_MIN; ppem < PPEM_MAX; ppem++){
		var instrs = autohint.autohint(glyph, ppem).instructions;
		tt.push('DUP', 'PUSHB_1', ppem, 'EQ', 'IF');
		var roundups = [];
		var rounddowns = [];
		for(var k = 0; k < instrs.roundingStems.length; k++){
			if(instrs.roundingStems[k].topkey[3] >= 0) {
				if(instrs.roundingStems[k].topkey[0] === 'ROUNDDOWN') rounddowns.push(instrs.roundingStems[k])
				else roundups.push(instrs.roundingStems[k]);
			} else {
				if(instrs.roundingStems[k].topkey[0] === 'ROUNDDOWN') roundups.push(instrs.roundingStems[k])
				else rounddowns.push(instrs.roundingStems[k]);
			}
			if(instrs.roundingStems[k].topkey[0] === 'ROUNDUP2') instrs.roundingStems[k].shpix = true;
		};

		if(roundups.length){
			tt.push('RUTG');
			var shpixes = [];
			for(var k = 0; k < roundups.length; k++){
				if(roundups[k].shpix) shpixes.push(roundups[k].topkey[1].id);
			}
			if(shpixes.length && shpixes.length <= 16) {
				pushargs(tt, shpixes, [64, shpixes.length]);
				tt.push('SLOOP', 'SHPIX')
			}
			tt = tt.concat(roundingStemInstrs(glyph, ppem, roundups))
		};
		if(rounddowns.length){
			tt.push('RDTG');
			tt = tt.concat(roundingStemInstrs(glyph, ppem, rounddowns))
		};
		if(instrs.alignedStems.length) {
			tt = tt.concat(alignedStemInstrs(glyph, ppem, instrs.alignedStems))
		};
		tt.push('EIF')
	};
	// Hint for bluezone alignments
	var PUSH = (glyph.nPoints < 256 ? 'PUSHB_' : 'PUSHW_');
	var h0 = autohint.autohint(glyph, 1000).instructions;
	if(h0.blueZoneAlignments.length) {
		var bluetops = [], bluebottoms = [];
		for(var k = 0; k < h0.blueZoneAlignments.length; k++){
			if(h0.blueZoneAlignments[k][0] === 'BLUETOP') bluetops.push(h0.blueZoneAlignments[k][1]);
			else bluebottoms.push(h0.blueZoneAlignments[k][1]);
		}
		tt.push('RTG');
		for(var k = 0; k < bluetops.length; k++){
			pushargs(tt, [bluetops[k].id, 1]);
			tt.push('MIAP[rnd]');
		}
		for(var k = 0; k < bluebottoms.length; k++){
			pushargs(tt, [bluebottoms[k].id, 2]);
			tt.push('MIAP[rnd]');
		}		
	}

	// Hint for in-stem alignments
	var ials = [], stemops = h0.roundingStems.concat(h0.alignedStems);
	for(var k = 0; k < stemops.length; k++){
		if(stemops[k].topaligns.length) ials.push(stemops[k].topaligns)
		if(stemops[k].bottomaligns.length) ials.push(stemops[k].bottomaligns)
	}
	ials.sort(function(p, q){ return p.length - q.length });
	var looplen = 0
	for(var k = 0; k < ials.length; k++){
		pushargs(tt, ials[k].map(function(x){ return x[2].id }), [ials[k][0][1].id, ials[k].length])
		tt.push('SLOOP', 'SRP0', 'ALIGNRP')
	}

	tt.push('IUP[y]')
	ch.instructions = tt.join('\n')
	glyph = tt = null;
}

rl.on('close', function() {
	if(buf) outstream.write(buf);
	outstream.end()
});