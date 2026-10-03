var ready_done = false,
ready = function() {
	if (ready_done)
		return;
	ready_done = true;
	loadSolution();
	if (isChallenge)
		challengeLoad();
}

if (document.readyState === 'complete')
	ready();
else if (document.addEventListener) { // gecko, webkit, opera, IE 9
	document.addEventListener("DOMContentLoaded", ready, false);
	window.addEventListener("load", ready, false);
}
else if (document.attachEvent) { // IE 8-
	document.attachEvent("onreadystatechange", ready);
	window.attachEvent("onload", ready);
}

var wallColor = false;
var wallEmblem = false;
var wallOrientation = 0;

var isChallenge = false;
var isTutorial = false;

var solution = new Array();
var count = new Array();
var mapdata = new Array();
var mapjson = new Array();
var htmlnotification = '';
var jsonmapdata = new Object;
//var jsonmapdata.solutions = new Array();
var mapType; // 1 = simple, 2 = normal, ...; used for mixpanel tracking

var pressedGoTime = 0;

function loadSolution(solution, moves, mapID) {
	if (solution) {
		var wallPositions = solution.split(':');
		var position = wallPositions[0].split('.');

		clearwalls(mapID);
		for(var i in position) {
			if (document.getElementById(mapID+','+position[i]) != undefined) {
				object = document.getElementById(mapID+','+position[i]);
				grid_click(object);

			}
		}
	}
	if (moves && mapID) {
		updateDsp(mapID, 'dspCount', moves+ " moves");
	}
}

function fixOldYSolution(solution) {
	//console.log('fixing solution', solution);
	if (solution.indexOf(':') > 0) {
		return solution;
	}
	var solutionWithYAxisFixed;
	var cordinates = solution.split('.');
	for (i = 0; i < cordinates.length; i++) {
		var xAndY = cordinates[i].split(',');
		var y = Number(xAndY[0]);
		var x = Number(xAndY[1]);
		y--;
		//console.log("fixoldy", x, y);
		solutionWithYAxisFixed += y + ',' + x + '.';
	}
	solutionWithYAxisFixed += ':';
	//console.log("fixoldy complete", solutionWithYAxisFixed);
	return solutionWithYAxisFixed;
}


function showNotification(html) {
	var div = document.createElement('div');
	var pref = '<div class="notification" align="center">';
	pref += '<div class="notification_close"><a href="javascript:" onclick="this.parentNode.parentNode.parentNode.removeChild(this.parentNode.parentNode);">[Close]</a> </div> ';
	pref += '<div style="overflow:auto;height:295px;">';
	var suff = '</div></div>';
	//var suff = '<button onclick="">'
	//suff += 'Close</button></div>';
	div.innerHTML = pref+html+suff;
	document.body.appendChild(div.firstChild);
}

function changeWallColor(newColor) {
	playerWallColor = newColor;
	loadSolution(null);
}
function changeWallEmblem(newEmblem) {
	playerWallEmblem = newEmblem;
	loadSolution(null);
}

function linkEmblem(emblem, orientation) {
	orientation = orientation - 0;
	var url = 'images/marks/';
	if (orientation == 0) return url+emblem;
	return url+'rotate.php?r='+orientation+'&emblem='+emblem;
}
function setWallStyle(playerObject) {

	if (typeof playerObject !== 'object') return;

	wallColor = playerObject.wallColor;
	wallEmblem = playerObject.wallEmblem;
	wallOrientation = playerObject.wallOrientation;
}



function grid_click(obj) {

	//Prepare data
	tmp = obj.id.split(',');
	mapid = tmp[0] - 0;
	y = tmp[1];
	x = tmp[2];

	//The users solution - prepare it if it's not started
	if (solution[mapid] == undefined) {
		getmapdata(mapid);
	}

	//Is this placing a wall, or removing one?
	var tmp = obj.id;
	childdiv = document.getElementById('child_'+tmp);
	if (obj.cv) {
		//Removing a wall
		obj.cv = false;

		//Remove Customized Background Color & Image
		obj.style.backgroundColor = '';
		obj.style.backgroundImage = '';
		obj.setAttribute("class", "o");
		childdiv.setAttribute("class", "child");

		mapdata[mapid].usedWallCount++;
		//Remove wall
		solution[mapid] = solution[mapid].replace('.'+y+','+x+'.', '.');
	} else {
		//Placing a wall
		if (mapdata[mapid].usedWallCount < 1) {
			updateDsp(mapid, 'dspWalls', "OUT!");
			return;
		}
		obj.cv = true;

		//Color goes on the bottom, Parent.
		//Then the chosen emblem in the Parent.
		// Then the emblem and color are smoothed with the faceted tile on top.

		//childdiv.removeAttribute("class");
		childdiv.setAttribute("class", "child w");

		if (wallColor == false) setWallStyle(userObj);
		if (wallColor == false) wallColor = '#666';

		obj.style.backgroundColor = wallColor;
		if (wallEmblem) {
			obj.style.backgroundImage="url("+linkEmblem(wallEmblem, wallOrientation)+")";
		}

		//Add Wall
		solution[mapid] += y+','+x+'.';
		mapdata[mapid].usedWallCount--;
	}
	if (isChallenge == true) {
		challengeWall(mapid);
	}
	updateDsp(mapid, 'dspWalls', mapdata[mapid].usedWallCount+" walls");
}

function updateDsp(mapid, element, data) {
	//if (mapdata[mapid] == undefined)
	//	return;
	//if (mapdata[mapid].example != true) {
	if (document.getElementById(mapid+','+element) != undefined) {
		handle = document.getElementById(mapid+','+element);
		handle.innerHTML = data;
	}
//}
}

function getmapdata(mapid) {

	if (typeof(mapdata[mapid]) != 'object')
		mapdata[mapid] = decryptJSON(jsonmapdata[mapid]);

	mapdata[mapid].usedWallCount = mapdata[mapid].walls;
	solution[mapid] = '.';
	updateDsp(mapid, 'dspWalls', mapdata[mapid].usedWallCount+" walls");
}

function doSend(mapid) {
	if (solution[mapid] == undefined) {
		getmapdata(mapid);
	}

	pressedGoTime = new Date().getTime();

	reqstr = "isChallenge="+isChallenge
	reqstr += "&r=getpath"
	reqstr += "&mapcode="+mapdata[mapid].code;
	reqstr += "&mapid="+mapid;
	reqstr += "&solution="+solution[mapid];
	reqstr += ":";

	ajax.requestFile = "do.php?"+reqstr; //prepare strdata
	ajax.onCompletion = request_path_done; // specify function to be executed on response
	ajax.runAJAX();
}

function requestSol(mapID) {
	ajax.requestFile = "do.php?r=getsol&mapID="+mapID; //prepare strdata
	ajax.onCompletion = requestSolDone; // specify function to be executed on response
	ajax.runAJAX();
}

function requestChallengeSolution(mapID, challengeID) {
	ajax.requestFile = "do.php?r=getChallengeSolution&mapID="+mapID+'&challengeID='+challengeID; //prepare strdata
	ajax.onCompletion = requestSolDone; // specify function to be executed on response
	ajax.runAJAX();
}

function requestSolDone() {
	var JO;
	JO = decryptJSON(ajax.response);
	if (JO.solution == 'undefined')
		return;
	JO.solution = fixOldYSolution(JO.solution);
	//clearwalls(JO.mapid);
	loadSolution(JO.solution, JO.moves, JO.mapid);
}

function clearwalls(mapid) {
	if (solution[mapid] == undefined) return;
	walls = solution[mapid].split('.');
	for(var i in walls) {
		tmp = walls[i].split(',');
		eid = mapid+','+tmp[0]+','+tmp[1];
		if (document.getElementById(eid) != undefined) {
			obj = document.getElementById(eid);
			obj.cv = false;

			childdiv = document.getElementById('child_'+obj.id);

			//Reset childdiv to it's default.
			childdiv.removeAttribute("class");
			childdiv.setAttribute("class", "child");

			//return the td obj back to it's default.
			obj.style.backgroundColor = '';
			obj.style.backgroundImage = '';
			obj.setAttribute("class", "o");
		}
	}
	solution[mapid] = undefined;
	getmapdata(mapid);
}

//TODO:An undo button rather than confirm..
function resetwalls(mapid) {
	answer = confirm("Remove walls and start fresh?");
	if (answer) {
		clearwalls(mapid);
	}
}

function request_path_done() {
	var JO = decryptJSON(ajax.response);
	var mapid = JO.mapid;
	mapjson[mapid] = JO;

	var speedbox = document.getElementById(mapid+',speed'),
	speed = speedbox.options[speedbox.selectedIndex].text,
	mute = !checkSound(mapid);

	nowTime = new Date().getTime();
	var responseTime = nowTime - pressedGoTime;

	if (typeof mixpanel != "undefined") {
		mixpanel.track('click go', {
			'speed': speed,
			'mute': mute,
			'mapid': mapid,
			'type': mapType,
			'response time': responseTime
		});
	}

	for(var i in JO.error)
		console.error('\n JO error ' + JO.error[i]);

		// TODO: Come up with a pleasant way to express a blocked path
	if (JO.blocked) {
		// var lastTarget;
		// for(i in JO.path) {
		// 	if (JO.path[i].blocked != true) continue;
		// 	lastTarget = JO.path[i].lastTarget;
		// }
		// if (lastTarget == 'f') lastTarget = 'finish';
		// alert("The path is blocked, can't reach "+lastTarget);
		alert("Uhm, the path is blocked...");

		//return;
	}


	var disptext = "Record: "+JO.best+" by "+JO.bestby;
	if (isChallenge)
		disptext = '';
	updateDsp(JO.mapid, 'dspID', disptext);

	mapdata[mapid].moveCount = new Object;
	mapdata[mapid].usedTiles = new Array();
	mapdata[mapid].restoreTiles = new Array();
	mapdata[mapid].pathColor = new Object;

	mapdata[mapid].pathsPending = JO.path.length;
	mapdata[mapid].isMultiPath = (JO.path.length > 1);

	for(i in JO.path) {
		mapdata[mapid].moveCount[i] = 0;
		mapdata[mapid].pathColor[i] = '#ffffff';
		//console.log("animatePath call:");
		//console.log(JO.path[i].pathArray, mapid, JO.path[i].start, i);
		animatePath(JO.path[i].pathArray, mapid, JO.path[i].start, i);
	}
}

function decryptJSON(text) {
	if (typeof(text) == 'undefined') return false;
	var JO;
	if (typeof(JSON) == 'undefined') {
		JO = !(/[^,:{}\[\]0-9.\-+Eaeflnr-u \n\r\t]/.test(text.replace(/"(\\.|[^"\\])*"/g, ''))) && eval('(' + text + ')');
	} else {
		JO = JSON.parse(text);
	}
	return JO;
}

function animatePath(path, mapid, start, pathNumber) {

	//console.log("animatePath funcStart...:", path, mapid);

	if (!path) return;

	var tmp = start.split(',');
	var y = tmp[0];
	var x = tmp[1];

	//Prepare the path
	var currentPosition = path[0];

	document.getElementById(mapid+',btn').disabled = true;
	doanimate(x, y, path, currentPosition, mapid, pathNumber);
}

function animatePathDone(mapid) {
	document.getElementById(mapid+',btn').disabled = false;
	if (isChallenge == true) {
		challengeGo(mapid);
	}
	if (typeof(currentPage) == "object") {
		scoresRequestPage(mapid, currentPage[mapid]);
	}

	//Mark off challenges
	//TODO: This hack is stupidd :(
	if(isChallenge && isTutorial == false)
	{
		for(var i = 0; i < mapjson[mapid].completedChallenges.length; i++)
		{
			var challengeId = mapjson[mapid].completedChallenges[i];
			var handle = document.getElementById("challenge_id_" + challengeId);

			if (handle.className.indexOf('challenge_complete') < 0) {

				handle.className = "challenge_complete";
				flashelement("challenge_id_" + challengeId, 4);
			}
		}
	}
}

function checkSound(mapid) {
	if (getCookie('pref_mute') == 'true') {
		return false;
	}
	if (typeof(soundManager) != 'object') {
		return false;
	}
	return true;
}



function doanimate(x, y, pathAsArray, currentTargetCode, mapid, pathNumber) {

	//console.log('the length is', pathAsArray.length);
	//if (pathAsArray.length < 1) return false;

	var nextTargetCode = pathAsArray[0] + '';

	if (pathAsArray.length < 1) nextTargetCode = '';


	//Animate current square, and move to next one.
	if (count[mapid] == undefined) {
		count[mapid] = 0;
	}
	//Set the color for the first target.
	if (count[mapid] == 0 && !(currentTargetCode > 0))
		mapdata[mapid].pathColor[pathNumber] = targetColor(currentTargetCode);

	//Display movecount

	if (mapdata[mapid].moveCount[1] > 0 && mapdata[mapid].moveCount[0] > 0) {
		var colorScores = '<span class="green">' + mapdata[mapid].moveCount[0] + '</span> + ';
		colorScores += '<span class="red">' + mapdata[mapid].moveCount[1] + '</span> = ' + count[mapid] + " moves";
		updateDsp(mapid, 'dspCount', colorScores);
	//updateDsp(mapid, 'dspCount', '<span class="green">' + mapdata[mapid].moveCount[0] + ' + ' + mapdata[mapid].moveCount[1] + ' = ' + count[mapid] + " moves");
	} else {
		updateDsp(mapid, 'dspCount', count[mapid]+ " moves");
	}
	//document.getElementById(mapid+',dspCount').innerHTML = count[mapid]+ " moves";

	//Get a handle on the element.
	var currentTileID = mapid+','+x+','+y;
	//Verify.
	if (document.getElementById(currentTileID) == undefined) {
		console.error("Path exited field...?");
		animatePathDone(mapid);
		return;
	}
	handle = document.getElementById(currentTileID);

	//Animate the first square in a path.
	if (count[mapid] == 0 && !(currentTargetCode > 0)) {
		count[mapid]--;
		mapdata[mapid].moveCount[pathNumber]--;
		currentTargetCode = nextTargetCode;
		if (!(currentTargetCode > 0))
			currentTargetCode = '2';
	}

	switch(currentTargetCode) {
		//The path is moving to a new position
		case '1': 		//1 - Up
		case '2':		//2 - Right
		case '3': 		//3 - Down
		case '4': 		//4 - Left
			//Track move count
			count[mapid]++;
			mapdata[mapid].moveCount[pathNumber]++;

			//Notify users on score levels;
			switch(count[mapid]) {
				case 100: case 200: case 300: case 400:
				case 500: case 600: case 700: case 800:
				case 900: case 1000:
					if (checkSound(mapid)) {
						soundManager.setVolume('charm', 40);
						soundManager.setPan('charm', 75)
						soundManager.play('charm');
					}
					//Flash
					flashelement(mapid+',dspCount', 4);
					break;
			}

			var childID = 'child_'+handle.id;
			childdiv = document.getElementById(childID);
			if (childdiv.className.indexOf('w') < 0) {
				childdiv.setAttribute('class', 'transition path'+pathNumber+'-'+currentTargetCode);

				handle.style.backgroundColor = mapdata[mapid].pathColor[pathNumber];

				var string = "if (document.getElementById('"+'child_'+currentTileID+"').className == 'transition path"+pathNumber+'-'+currentTargetCode+"')";
				string += "document.getElementById('"+'child_'+currentTileID+"').setAttribute('class', 'child');";
				setTimeout(string, 855);

				//Maintain disabled appearnce of checkpoints
				if (handle.pressed == true) {
					setTimeout("document.getElementById('"+currentTileID+"').style.backgroundColor = '#dddddd';", 865);
				} else {
					string = "if (document.getElementById('"+childID+"').className.indexOf('w') < 0) ";
					string += "document.getElementById('"+currentTileID+"').style.backgroundColor = '';";
					setTimeout(string, 865);
				}
			}

			break;

		//Teleports or checkpoints
		case 'u': case 'r':
			if (mapdata[mapid].isMultiPath == false) {
				handle.style.backgroundColor = '#dddddd';
				setTimeout("document.getElementById('"+currentTileID+"').style.backgroundColor = '#dddddd';", 865);
				handle.pressed = true;
			} else {
				if (contains(mapdata[mapid].usedTiles, currentTileID)) {
					handle.style.backgroundColor = '#dddddd';
					setTimeout("document.getElementById('"+currentTileID+"').style.backgroundColor = '#dddddd';", 865);
					handle.pressed = true;
				} else {
				//mapdata[mapid].usedTiles.push(currentTileID);
				//break;
				}
			}

			if (contains(mapdata[mapid].usedTiles, currentTileID) == false)
				mapdata[mapid].usedTiles.push(currentTileID);

	//mapdata[mapid].restoreTiles.push("document.getElementById('"+currentTileID+"').style.backgroundColor = '';");
	//mapdata[mapid].restoreTiles.push("document.getElementById('"+currentTileID+"').pressed = false;");

	//alert(mapdata[mapid].pathColor[pathNumber]);

	//break;
	}

	//Sound effects
	if (nextTargetCode == 'r') {
		if (checkSound(mapid)) {
			soundManager.setVolume('bling', 40);
			soundManager.setPan('bling', -75)
			soundManager.setVolume('blingb', 40);
			soundManager.setPan('blingb', 75)
			if (pathNumber == 0)
				soundManager.play('bling');
			if (pathNumber == 1)
				soundManager.play('blingb');
		}
	}

	//Done messing with current target
	//Now take pre-action regarding the next tile.
	//Speaking of the next tile - does it exist?
	//End of the line?
	if (nextTargetCode == '' || typeof(nextTargetCode) == 'undefined') {


		mapdata[mapid].pathsPending--;
		//console.log('path pending', mapdata[mapid].pathsPending);
		if (mapdata[mapid].pathsPending > 0)
			return;

		//console.log('path pending complete', mapdata[mapid].pathsPending);

		//Did we beat or tie any records?
		//Saw someone do this, thought it was clever.
		//Switch for range result.
		var disptext = ""
		var improvedScore = (count[mapid] > mapjson[mapid].mybest && mapjson[mapid].mybest != "0");
		switch (true) {
			case (count[mapid] > mapjson[mapid].best):
				disptext = "Beat "+mapjson[mapid].bestby+"'s record of "+mapjson[mapid].best+" with "+count[mapid]+"!";
				break;

			case (count[mapid] == mapjson[mapid].best):
				disptext = "Tied "+mapjson[mapid].bestby+"'s record of "+mapjson[mapid].best;
				break;

			case (mapjson[mapid].mybest == "0"):
				disptext = "You scored "+count[mapid]+"!";
				break;

			case (count[mapid] > mapjson[mapid].mybest):
				disptext = "Improved score "+mapjson[mapid].mybest+ " to "+count[mapid];
				break;

			case (count[mapid] == mapjson[mapid].mybest):
				disptext = "Tied personal best of "+count[mapid];
				break;

			case (count[mapid] < mapjson[mapid].mybest):
				disptext = "You got "+count[mapid]+". Your best is "+mapjson[mapid].mybest;
				break;
		}
		//if anything worth mentioning happend let them know.
		if (disptext != "") {
			if (checkSound(mapid) && improvedScore) {
				soundManager.setVolume('charm', 50);
				soundManager.setVolume('sc', 50);
				soundManager.play('charm');
				soundManager.play('sc');
			}
			updateDsp(mapid, 'dspID', disptext);
			flashelement(mapid+',dspID', 8, "#FF3377");
		}

		//This is the end, lets reset stuff to defaults.
		count[mapid] = 0;
		mapdata[mapid].pathColor[pathNumber] = '#ffffff';

		restoreColorToMap(mapid);

		//We're done,
		animatePathDone(mapid);
		return;
	}


	//The next tile exists, how fast should we get there?
	rs = 84;
	//How fast should we be going?
	selectbox = document.getElementById(mapid+',speed');
	var selectedSpeed = selectbox.options[selectbox.selectedIndex].value;
	switch (selectedSpeed) {
		case '1':
			rs =180;
			break;

		case '2':
			rs =94;
			break;

		case '3':
			rs =44;
			break;

		case '4':
			rs =22;
			break;

		case '5':
			rs =1;
			break;

	}

	var nextTargetValue = nextTargetCode.substring(0,1);
	if (nextTargetCode.includes(",")) nextTargetValue = 0;

	switch(nextTargetValue) {
		//Are we just moving someplace?
		case '1':
			x--;
		break; 		//1 - Up
		case '2':
			y++;
		break; 		//2 - Right
		case '3':
			x++;
		break; 		//3 - Down
		case '4':
			y--;
		break; 		//4 - Left

		case 'c': case 'f':
			rs = rs + 250;
			if (selectedSpeed <= 2) rs = rs + 200;
			mapdata[mapid].pathColor[pathNumber] = targetColor(nextTargetCode);

		break;
	}

	//console.log('nexttargetcode is', nextTargetCode);
	//Or are we warping to cordinates?
	if (nextTargetCode.includes(",")) {

		loc = nextTargetCode.split(',');
		y = loc[0];
		x = loc[1];
		tpEid = mapid+','+x+','+y;

		if (checkSound(mapid)) {
			soundManager.setVolume('ufoblip', 30);
			if (pathNumber == 0)
				soundManager.setPan('ufoblip', 70);
			else
				soundManager.setPan('ufoblip', -70);
			soundManager.play('ufoblip');
		}
		document.getElementById(tpEid).style.backgroundColor='';
		flashelement(tpEid, 8, mapdata[mapid].pathColor[pathNumber]);
		//Slow down
		rs = rs + (1350 - (selectedSpeed * 100));
	}

	//console.log('path as array:', pathAsArray);
	pathAsArray.splice(0, 1);

	if (count[mapid] % 2 == 1 && rs == 0) {
		doanimate(x,y,p,nextTargetCode,mapid,pathNumber);
	} else  {
		var nextAnimate = function () {
			doanimate(x,y,pathAsArray,nextTargetCode,mapid,pathNumber);
		}
		var uselessName = setTimeout(nextAnimate,rs);
	}

	//setTimeout("doanimate("+x+","+y+",'"+pathAsArray+"','"+nextTargetCode+"','"+mapid+"','"+pathNumber+"')",rs);
}

function restoreColorToMap(mapid) {
	var eid;
	for(var i in mapdata[mapid].usedTiles) {
		eid = mapdata[mapid].usedTiles[i];

		setTimeout("document.getElementById('"+eid+"').style.backgroundColor = '';", 2500);
		setTimeout("document.getElementById('"+eid+"').pressed = false;" , 2500);
	}
	mapdata[mapid].usedTiles = new Array();
}


function targetColor(target) {
	var r = '#ccc';
	switch(target) {
		case 'c1':
			r = '#F777FF';
			break;
		case 'c2':
			r = '#FFFF11';
			break;
		case 'c3':
			r = '#FF4466';
			break;
		case 'c4':
			r = '#ff9911';
			break;
		case 'c5':
			r = '#00FFFF';
			break;
		case 'c6':
			r = '#a12ec4';
			break;
		case 'c7':
			r = '#46c0a0';
			break;
		case 'c8':
			r = '#33ff33';
			break;
		case 'c9':
			r = '#f032e6';
			break;
		case 'c10':
			r = '#d2f53c';
			break;
		case 'c11':
			r = '#fabebe';
			break;
		case 'c12':
			r = '#9090f4';
			break;
		case 'c13':
			r = '#e6beff';
			break;
		case 'c14':
			r = '#aa6e28';
			break;
		case 'c15':
			r = '#fffac8';
			break;

		case 'f1':
			r = '#ccc';
	}
	return r;
}


function flashelement(eid, times, color, speed) {

	if (document.getElementById(eid) == null) return;
	var elementToFlash = document.getElementById(eid);
	if (elementToFlash.isBeingFlashed == true) return;
	elementToFlash.isBeingFlashed = true;

	if (!color) {
		color = "#FFFF44";
	}
	if (!speed) {
		speed = 220;
	}
	speedon = speed * .5;

	var currentclass = elementToFlash.className;
	if (elementToFlash.classOrigName != undefined)
		currentclass = elementToFlash.classOrigName;
	var currentColor = elementToFlash.style.backgroundColor;
	elementToFlash.className='no_transition '+currentclass;
	elementToFlash.style.backgroundColor = '#000000';
	for (var i=0; i<times; i++) {
		//Flash bright
		setTimeout("document.getElementById('"+eid+"').style.color = '#000000'", i*speed);
		setTimeout("document.getElementById('"+eid+"').style.backgroundColor = '"+color+"'", i*speed);
		//Flash out
		setTimeout("document.getElementById('"+eid+"').style.color = ''", (i*speed) + speedon);
		setTimeout("document.getElementById('"+eid+"').style.backgroundColor = ''", (i*speed) + speedon);
	}
	setTimeout("document.getElementById('"+eid+"').style.backgroundColor = '"+currentColor+"'", (i*speed) + 200);
	setTimeout("document.getElementById('"+eid+"').isBeingFlashed = false", (i*speed) + 220);
}


function contains(a, obj) {
	var i = a.length;
	while (i--) {
		if (a[i] === obj) {
			return true;
		}
	}
	return false;
}


//Shows a solution temporarly
function useSolution(mapid, inputSolution, moves, tempWallColor, tempWallEmblem, tempWallOrientation, solutionID) {

	$('.solutionSelected').removeClass('solutionSelected');
	$('#solution_'+solutionID).addClass('solutionSelected');

	inputSolution = fixOldYSolution(inputSolution);

	solution[mapid] = inputSolution;
	var animateA = "showTempSolution(\""+mapid+"\", \""+inputSolution+"\", \""+moves+"\", \""+tempWallColor+"\", \""+tempWallEmblem+"\", \""+tempWallOrientation+"\");";
	var animateB = "showTempSolution(\""+mapid+"\", \""+inputSolution+"\", \""+moves+"\", false, false, false);";
	//TODO: Sticky colors for the placed walls by the user would be cool.
	//var animateC = "wallColor = false; wallEmblem = false;";
	setTimeout(animateA, 50);
	setTimeout(animateB, 150);
	setTimeout(animateA, 250);
	setTimeout(animateB, 350);
	setTimeout(animateA, 450);
	setTimeout(animateB, 550);
}
//Shows a solution for temporary use, see 'RestoreSolution'
function showTempSolution(mapid, tempSolution, moves, tempWallColor, tempWallEmblem, tempWallOrientation) {


	var savedSolution = '';
	if (typeof tempSolution == 'undefined') tempSolution = '';

	if (typeof solution[mapid] !== 'undefined') {
		savedSolution = solution[mapid] + ':';
	}

	//console.log('showTempSolution', mapid, tempSolution, solution, savedSolution);

	wallColor = tempWallColor;
	wallEmblem = tempWallEmblem;
	wallOrientation = tempWallOrientation;

	//tempSolution = fixOldYSolution(tempSolution);

	position = tempSolution.split(':');
	position = position[0].split('.');

	clearwalls(mapid);
	for(var i in position) {
		if (document.getElementById(mapid+','+position[i]) != undefined) {
			object = document.getElementById(mapid+','+position[i]);
			grid_click(object);

		}
	}
	if (moves && mapid) {
		updateDsp(mapid, 'dspCount', moves+ " moves");
	}

	mapdata[mapid].savedSolution = savedSolution;
}




//Restores a solution after a showTempSolution
function restoreSolution(mapid) {
	showTempSolution(mapid, mapdata[mapid].savedSolution, 0, false, false);
}

function displayMap(mapid, divID, goalSize, solution, moves, challengeMap, isThumb) {

	clearwalls(mapid);
	var stringURL = 'a/map/'+mapid+".js";
	if (challengeMap == true) stringURL = 'a/challenge/'+mapid+".js";
	$.ajax({
		type: "GET",
		url: stringURL,
		dataType: 'json',
		cache: true,
		data: '',
		//TODO: Better fail option?
		fail: (function() { console.log("FAIL Map Download"); }),
		complete: function(data) {
			if (isThumb) {
				$("#"+divID).html(mapThumbnailHTML(decryptJSON(data.responseText), goalSize)).fadeIn('fast');
			} else {
				$("#"+divID).html(mapAsHTML(decryptJSON(data.responseText), goalSize)).fadeIn('fast');
				//$("#"+divID).html(mapAsHTML(decryptJSON(data.responseText), goalSize)).show();
				mapdata[mapid].savedSolution = solution;
				restoreSolution(mapid);
			}
		}
	});
}

var Tile = {
"o" : "Open",
"s" : "Start",
"f" : "Finish",
"c" : "Checkpoint",
"r" : "Rock",
"t" : "Teleport In",
"u" : "Teleport Out",
"p" : "Unbuildable",
"z" : "Directional Force",
"x" : "Single-Path-Rock"};

//Map as object. If target width is NULL or False, default width is used.
function mapAsHTML(map, targetWidth, mapEditor) {

	//
	map.mapid = map.ID;
	//console.log("Map loaded via javascript: MapID:", map.mapid);
	//console.log("MapObj", map);
	mapdata[map.ID] = map;
	getmapdata(map.ID);

	//Map bigger than target width?
	if (!targetWidth || (map.width * 35) <= targetWidth)
	{
		//Use standard size.
		targetWidth = (map.width * 35);
	}

	var scale = map.width / targetWidth;
	//alert(scale);

	//var width = parseInt(map.width / scale);
	//var height = parseInt(map.height / scale);

	var tileWidth = parseInt((map.width / scale) / map.width);
	var tileHeight = tileWidth;

	var width = tileWidth * map.width;
	var height = tileHeight * map.height;

	var mapgrid = '';

	mapgrid += '<div style="clear:both;"></div><div class="map playable" style="width:'+width+'px; height:'+height+'px">';

	for (var y in map.tiles) {
		for (var x in map.tiles[y]) {
			var type = map.tiles[y][x][0];
			var value = map.tiles[y][x][1];
			if (!value) value = '';
			var idHandle = map.ID+','+y+','+x;
			if (mapEditor == true) {
				mapgrid += "<div style='float:left; width:"+tileWidth+"px; height:"+tileHeight+"px; ' class='mapcell "+type+value+"' title='Position: "+x+","+y+"' id='"+idHandle+"' onMouseOver='mapEditOver(this)' onMouseDown='mapEditClick(this)' >";
				mapgrid += "<div id='child_"+idHandle+"' class='child'></div></div>";
			} else if (type == 'o') {
				mapgrid += "<div style='float:left; width:"+tileWidth+"px; height:"+tileHeight+"px; ' class='mapcell "+type+value+"' title='Position: "+x+","+y+"' id='"+idHandle+"' onClick='grid_click(this)' >";
				mapgrid += "<div id='child_"+idHandle+"' class='child'></div></div>";
			} else {
				mapgrid += "<div style='float:left; width:"+tileWidth+"px; height:"+tileHeight+"px; ' class='mapcell "+type+value+"' title='"+Tile[type]+" "+value+" On: "+x+","+y+"' id='"+idHandle+"' >";
				mapgrid += "<div id='child_"+idHandle+"' class='child'></div></div>";
			}
		}
	}
	mapgrid += '</div><div style="clear:both"></div>';

	if (mapEditor == true) return mapgrid;

	var r = '';

	//TODO: Track down where that 1 pixel is comingfrom, width-1 is a hack.
	r += "<div id='"+map.ID+",outer' class='grid_outer' style='width:"+(width)+"px;height:"+(height+45)+"px;'>";

	r += "	<div class='grid_dsp_left' style='width:60%;'>";
	r += "		<div id='"+map.ID+",dspID' title='MapID: "+map.ID+"'>";
	r += "		MapID: "+map.ID;
	r += "		</div>";
	r += "	</div>";

	r += "		<div id='"+map.ID+",dsptr' class='grid_dsp_right' style='width:38%;'>";
	r += "		<span id='"+map.ID+",dspWalls' class='grid_dsp_data'> ";
	r += "		"+map.walls+" walls";
	r += "		</span>";
	r += "		<span>";
	r += "		( <a href='javascript:resetwalls("+map.ID+")'>Reset</a> )";
	r += "		</span>";
	r += "	</div>";

	r += mapgrid;


	r += "	<div id='"+map.ID+",dspbl' class='grid_dsp_left' style='width:60%;'> ";
	r += "	<input id='"+map.ID+",btn' type='button' onclick='doSend("+map.ID+")' value='Go!' />";
	r += "	Speed:";
	r += getSpeedOptions(map.ID);
	r += "	</div>";

	r += "	<div class='grid_dsp_mid' style='width:5%;'>";
	r += getMuteOption(map.ID);
	r += "	</div>";

	r += "	<div id='"+map.ID+",dspbr' class='grid_dsp_right' style='width:34%;'> ";
	r += "		<div id='"+map.ID+",dspCount' class='grid_dsp_data'> ";
	r += "		0 moves";
	r += "		</div>";
	r += "	</div>";
	r += "</div>";

	return r;
}

function mapThumbnailHTML(map, targetWidth, targetHeight) {
	if (!targetWidth) targetWidth = 120;
	if (!targetHeight) targetHeight = 320;

	var heightScale = map.height / targetHeight;
	var widthScale = map.width / targetWidth;

	//Size based on target width
	var tileSize = Math.floor(map.width / widthScale / map.width);
	//Too tall using width?
	if (tileSize * map.height > targetHeight) {
		//Use target height
		tileSize = Math.floor(map.height / heightScale / map.height);
	}
	//console.log('tw', tileSize * map.height, targetHeight);

	var width = tileSize * map.width;
	var height = tileSize * map.height;

	var mapgrid = '';
	var r = '';
	r += map.name;

	mapgrid += '<div class="map" style="width:'+width+'px; height:'+height+'px">';
	for (var y in map.tiles) {
		for (var x in map.tiles[y]) {
			var type = map.tiles[y][x][0];
			var value = map.tiles[y][x][1];
			if (!value) value = '';

			mapgrid += "<div style='float:left; width:"+tileSize+"px; height:"+tileSize+"px; ' class='mapcell "+type+value+"'>";
			mapgrid += "</div>";
		}
	}
	mapgrid += '</div>';
	r += mapgrid;
	return r;
}

function setMute(value)
{
	var value = getCookie('pref_mute');
	$('.mapMute').removeClass("mapMute_"+value);
	if (value == 'true')	{
		value = 'false';
		soundManager.setVolume('pit', 20);
		soundManager.setPan('pit', -60)
		soundManager.play('pit');
	} else {
		value = 'true';
	}
	savePref('mute', value);
	$('.mapMute').addClass("mapMute_"+value);
}

function setSpeed(value) {
	$(".selectSpeed").val(value);
	savePref('speed', value);
}

function getMuteOption(mapID) {
	var r = '';
	var muted = 'false';
	if (getCookie('pref_mute') == 'true') {
		muted = "true";
	}
	r += "<a title='Mute sound?' class='mapMute mapMute_"+muted+" unselectable' href='javascript:setMute()' id='mapMute'/></a>";
	return r;
}

function getSpeedOptions(mapID) {
	var listObj = new Object;
	var selectedSpeed = 2;
	if (getCookie('pref_speed')) {
		selectedSpeed = getCookie('pref_speed');
	}
	listObj[1] = 'Slow';
	listObj[2] = 'Med';
	listObj[3] = 'Fast';
	listObj[4] = 'Ultra';
	if (userObj.hasInsaneSpeed) listObj[5] = 'Insane';
	var r = '';
	r += "	<select class='selectSpeed' onChange='setSpeed(this.value)' id='"+mapID+",speed'>";
	for (var i in listObj) {
		r += "<option value='"+i+"'";
		if (i == selectedSpeed) r += "selected='selected'";
		r += ">"+listObj[i]+"</option>";
	}
	r += "	</select>";
	return r;
}
