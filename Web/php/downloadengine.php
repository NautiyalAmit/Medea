<?php

if (isset($_GET['file']))

{

  $fullfilename=$_GET['file'];

  $filename=basename($fullfilename);

  header('Content-Type: application/octet-stream');

  header("Content-Disposition: attachment; filename=\"{$filename}\""); 

  header('Content-Transfer-Encoding: binary');

  // load the file to send:

  readfile('../'.$fullfilename);

}

?>