function showSignin() {
	if (document.getElementById('oid_hidden') !== undefined) {
		document.getElementById('oid_hidden').id = 'oid_wrapper';
	}
}
function hideSignin() {
	if (document.getElementById('oid_wrapper') !== undefined) {
		document.getElementById('oid_wrapper').id = 'oid_hidden';
	}
}

//Because some browsers do not support console.log
function logContent() {
	
	//if (getCookie('showConsole') == true) {
		console.log(arguments);
	//}
}


function savePref(pref, value) {
	setCookie('pref_'+pref, value, 9999);
}

//Cookie functions from w3schools.com
function setCookie(c_name,value,exdays)
{
	var exdate=new Date();
	exdate.setDate(exdate.getDate() + exdays);
	var c_value=escape(value) + ((exdays==null) ? "" : "; expires="+exdate.toUTCString());
	document.cookie=c_name + "=" + c_value;
}
function getCookie(c_name)
{
	var i,x,y,ARRcookies=document.cookie.split(";");
	for (i=0;i<ARRcookies.length;i++)
	{
		x=ARRcookies[i].substr(0,ARRcookies[i].indexOf("="));
		y=ARRcookies[i].substr(ARRcookies[i].indexOf("=")+1);
		x=x.replace(/^\s+|\s+$/g,"");
		if (x==c_name)
		{
			return unescape(y);
		}
	}
	return "";
}


//Make unselectable elements unselectable (hack for IE 9.0 and below, which doesn't support our CSS)
$(document).ready(function()
{
	if ($.browser.msie && $.browser.version < 10) 
	{
		$('.unselectable').find(':not(input)').attr('unselectable', 'on');
	}
});