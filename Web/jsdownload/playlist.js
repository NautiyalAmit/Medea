//<![CDATA[
$(document).ready(function(){

	new jPlayerPlaylist({
		jPlayer: "#jquery_jplayer_1",
		cssSelectorAncestor: "#jp_container_1"
	}, [
{
			title:"Cro Magnon Man",
			artist:"The Stark Palace",
			mp3:"http://www.jplayer.org/audio/mp3/TSP-01-Cro_magnon_man.mp3",
			poster: "http://www.jplayer.org/audio/poster/The_Stark_Palace_640x360.png",
			free:"true"
		},
		{
			title:"Your Face",
			artist:"The Stark Palace",
			mp3:"http://www.jplayer.org/audio/mp3/TSP-05-Your_face.mp3",
			poster: "http://www.jplayer.org/audio/poster/The_Stark_Palace_640x360.png",
			free:"true"
		},
		{
			title:"Hidden",
			artist:"Miaow",
			mp3:"http://www.jplayer.org/audio/mp3/Miaow-02-Hidden.mp3",
			poster: "http://www.jplayer.org/audio/poster/Miaow_640x360.png",
			free:"true"
		},
		{
			title:"Big Buck Bunny Trailer",
			artist:"Blender Foundation",
			m4v:"http://www.jplayer.org/video/m4v/Big_Buck_Bunny_Trailer.m4v",
			poster:"http://www.jplayer.org/video/poster/Big_Buck_Bunny_Trailer_480x270.png",
			free:"true"
		},
		{
			title:"Finding Nemo Teaser",
			artist:"Pixar",
			m4v: "http://www.jplayer.org/video/m4v/Finding_Nemo_Teaser.m4v",
			poster: "http://www.jplayer.org/video/poster/Finding_Nemo_Teaser_640x352.png",
			free:"true"
		},
		{
			title:"Cyber Sonnet",
			artist:"The Stark Palace",
			mp3:"http://www.jplayer.org/audio/mp3/TSP-07-Cybersonnet.mp3",
			oga:"http://www.jplayer.org/audio/ogg/TSP-07-Cybersonnet.ogg",
			poster: "http://www.jplayer.org/audio/poster/The_Stark_Palace_640x360.png"
		},
		{
			title:"Incredibles Teaser",
			artist:"Pixar",
			m4v: "http://www.jplayer.org/video/m4v/Incredibles_Teaser.m4v",
			ogv: "http://www.jplayer.org/video/ogv/Incredibles_Teaser.ogv",
			webmv: "http://www.jplayer.org/video/webm/Incredibles_Teaser.webm",
			poster: "http://www.jplayer.org/video/poster/Incredibles_Teaser_640x272.png"
		},
		{
			title:"Tempered Song",
			artist:"Miaow",
			mp3:"http://www.jplayer.org/audio/mp3/Miaow-01-Tempered-song.mp3",
			oga:"http://www.jplayer.org/audio/ogg/Miaow-01-Tempered-song.ogg",
			poster: "http://www.jplayer.org/audio/poster/Miaow_640x360.png"
		},
		{
			title:"Lentement",
			artist:"Miaow",
			mp3:"http://www.jplayer.org/audio/mp3/Miaow-03-Lentement.mp3",
			oga:"http://www.jplayer.org/audio/ogg/Miaow-03-Lentement.ogg",
			poster: "http://www.jplayer.org/audio/poster/Miaow_640x360.png"
		}	

	], {
		swfPath: "js",
		solution: "flash, html",
		supplied: "webmv, ogv, m4v, oga, mp3"
	});
});
//]]>