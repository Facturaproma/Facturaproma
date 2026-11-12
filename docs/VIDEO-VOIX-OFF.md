# Vidéo « Votre première facture en 1 minute » : versions et voix off

## Fichiers

- `media/facturapro-premiere-facture.mp4` : version française, 44 s, 1080×1920, muette, sous-titres incrustés.
- `media/facturapro-premiere-facture-ar.mp4` : version arabe (application et sous-titres en arabe), même découpage.
- Refaire une version : `FRAMES_DIR=… [VIDEO_LANG=ar] node scripts/video/film.js`, puis `python3 scripts/video/build.py`, lancé dans le dossier des images.
- Données fictives uniquement : Atelier Atlas SARL, Café Nour / مقهى النور.

## Texte de la voix off en darija (à enregistrer par le propriétaire)

Aucune voix de synthèse en darija n'est disponible dans l'environnement de l'assistant. Il vaut mieux une vraie voix.

| Temps | Écran | Darija (à lire) | Transcription latine |
|---|---|---|---|
| 0:00 – 0:05 | Titre | فاكتورابرو: الفاكتورة ديالك الأولى ف دقيقة وحدة. | FacturaPro : l'facture dyalek l'oula f dqiqa wa7da. |
| 0:05 – 0:12 | Client | بدا بالكليان: السمية، ICE، العنوان والتيليفون. | Bda b l'client : smiya, ICE, l'adresse w t-tilifoun. |
| 0:12 – 0:21 | Facture | زيد السلعة ولا الخدمات ديالك… HT و TVA و TTC كيتحسبو بوحدهم. | Zid sel3a wla services dyalek… HT, TVA w TTC kayt7asbou b-wa7dhoum. |
| 0:21 – 0:28 | Émission, PDF | النيميرو كيتعطى أوتوماتيك، بلا ما يتعاود. صيفطها ف واتساب، PDF ولا طبعها. | N-numéro kayt3ta automatique, bla ma yt3awed. Sifetha f WhatsApp, PDF wla tba3ha. |
| 0:28 – 0:34 | Paiement | ملي يخلصك الكليان، سجل الخلاص: الفاكتورة كتولي مخلصة. | Mlli ykhalsek l'client, sajjel l'khlas : l'facture katwelli mkhelsa. |
| 0:34 – 0:39 | Tableau de bord | وف لوحة التحكم كتشوف كلشي: البيع، الخلاص، السلعة والفلوس. | W f tableau de bord katchouf kolchi : l-bi3, l-khlas, s-sel3a w l-flous. |
| 0:39 – 0:44 | Fin | جرب فاكتورابرو بلاش، 30 يوم. | Jarreb FacturaPro b-blach, 30 youm. |

Enregistrement : téléphone près de la bouche, pièce calme, une seule prise de 44 s, ou une prise par ligne. Un vocal WhatsApp suffit.
Assemblage : `ffmpeg -i video.mp4 -i voix.m4a -map 0:v -map 1:a -c:v copy -c:a aac -b:a 128k -shortest sortie.mp4`, sans réencoder l'image.
