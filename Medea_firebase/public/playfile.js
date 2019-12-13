let element = document.createElement("div")
element.innerHTML="<p> player to be imported here! </p>" // To be replaced by the player's code
let divelement = document.getElementsByClassName("container")[0];
console.log(divelement);
let id_song = document.getElementsByClassName("d-block w-100")[0];
console.log(id_song);
id_song.addEventListener("click",function(e){

    divelement.replaceWith(element);

});


// console.log(id_song[0]);
// id_song.
// let element = document.createElement("div")
// element.innerHTML="<p> element replaced </p>"