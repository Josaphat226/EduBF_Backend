import json, os
from pypdf import PdfReader, PdfWriter

DOSSIER, SORTIE = "pdf-a-reparer", "pdf-repares"
os.makedirs(SORTIE, exist_ok=True)
manifeste = json.load(open(os.path.join(DOSSIER, "manifeste.json"), encoding="utf-8"))

for id_ in manifeste:
    try:
        r = PdfReader(os.path.join(DOSSIER, f"{id_}.pdf"))
        if r.is_encrypted and not r.decrypt(""):
            print(id_, "ÉCHEC : un mot de passe est réellement exigé")
            continue
        w = PdfWriter()
        for page in r.pages:
            w.add_page(page)
        w.write(os.path.join(SORTIE, f"{id_}.pdf"))
        print(id_, "ok")
    except Exception as e:
        print(id_, "ERREUR", e)