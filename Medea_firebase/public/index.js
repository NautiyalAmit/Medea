// console.log("js conneceted!")
let idsubmit = document.querySelector('#signup').addEventListener('click',function(e){
// console.log("clicked");
let idforemail = document.querySelector("#exampleInputEmail1");
// console.log(idforemail);
let val = idforemail.value;
// console.log(val);
let bin = val.includes(".com");
if (bin==false){
         window.alert("Please check e-mail id!")
     }
    })
